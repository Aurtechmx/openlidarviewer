/**
 * exportPngTextChunks.test.ts — byte-level contract for the PNG text-chunk
 * metadata writer (`src/export/pngTextChunks.ts`).
 *
 * The writer is the foundation of figure provenance: every Studio PNG and
 * saved snapshot carries its build / CRS / colour-mode / camera facts as
 * standard `tEXt` / `iTXt` chunks that exiftool, Python's PIL, and ImageMagick
 * all read. A malformed chunk (wrong length field, wrong CRC, chunk after
 * IEND) makes strict decoders reject the WHOLE image — so this suite pins the
 * byte layout exactly, against a hand-built fixture with independently
 * verified CRCs, not just via encode→decode symmetry.
 */

import { test, expect } from 'vitest';
import { encodePngTextChunks, readPngTextChunks } from '../src/export/pngTextChunks';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture — a real, minimal 1×1 8-bit grayscale PNG (67 bytes)
// ─────────────────────────────────────────────────────────────────────────────
//
// Built once with Node's zlib (deflate of a single filter-0 + one-pixel row)
// and a reference CRC-32 implementation that reproduces the canonical check
// value crc32("123456789") = 0xCBF43926. Layout:
//
//   offset  0..7   PNG signature (137 80 78 71 13 10 26 10)
//   offset  8..32  IHDR (13-byte payload: 1×1, bit depth 8, colour type 0)
//   offset 33..54  IDAT (10-byte zlib stream)
//   offset 55..66  IEND (empty payload, CRC AE 42 60 82 — the well-known
//                  constant every PNG on disk ends with)
const TINY_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0, 58, 126, 155, 85,
  0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 168, 7, 0, 0, 129, 0, 128, 211, 148, 83, 74,
  0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

/** Offset of the fixture's IEND chunk (length field start). */
const IEND_OFFSET = 55;

/** Walk every chunk's 4-char type, in file order — a test-local reader so the
 *  byte-level assertions don't lean on the module under test. */
function chunkTypes(png: Uint8Array): string[] {
  const types: string[] = [];
  let off = 8;
  while (off + 8 <= png.length) {
    const len = (png[off] << 24) | (png[off + 1] << 16) | (png[off + 2] << 8) | png[off + 3];
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    types.push(type);
    off += 12 + len;
  }
  return types;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture sanity + reader on a chunk-free PNG
// ─────────────────────────────────────────────────────────────────────────────

test('the fixture is a plain IHDR/IDAT/IEND PNG with the canonical IEND CRC', () => {
  expect(chunkTypes(TINY_PNG)).toEqual(['IHDR', 'IDAT', 'IEND']);
  // Every valid PNG ends with the same 12 IEND bytes; the CRC constant
  // 0xAE426082 is the CRC-32 of the four ASCII bytes "IEND".
  expect([...TINY_PNG.slice(IEND_OFFSET)]).toEqual([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
});

test('readPngTextChunks returns [] for a PNG with no text chunks', () => {
  expect(readPngTextChunks(TINY_PNG)).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// tEXt encoding — exact byte layout
// ─────────────────────────────────────────────────────────────────────────────

test('a Latin-1 entry is spliced as one tEXt chunk immediately before IEND', () => {
  const out = encodePngTextChunks(TINY_PNG, [
    { keyword: 'Software', text: 'OpenLiDARViewer' },
  ]);

  // 12 bytes of chunk framing + 8 (keyword) + 1 (NUL) + 15 (text) = 36.
  expect(out.length).toBe(TINY_PNG.length + 36);
  // Everything before the insert point is byte-identical to the input.
  expect([...out.slice(0, IEND_OFFSET)]).toEqual([...TINY_PNG.slice(0, IEND_OFFSET)]);
  // The IEND chunk is untouched and still terminates the file.
  expect([...out.slice(out.length - 12)]).toEqual([...TINY_PNG.slice(IEND_OFFSET)]);
  expect(chunkTypes(out)).toEqual(['IHDR', 'IDAT', 'tEXt', 'IEND']);

  // The spliced chunk, byte for byte: length 24 big-endian, type "tEXt",
  // "Software" NUL "OpenLiDARViewer", then CRC 0x6BE1095D — computed with a
  // reference CRC-32 that reproduces the canonical check value
  // crc32("123456789") = 0xCBF43926, so the constant is independently good.
  const chunk = out.slice(IEND_OFFSET, IEND_OFFSET + 36);
  expect([...chunk.slice(0, 4)]).toEqual([0, 0, 0, 24]);
  expect(String.fromCharCode(...chunk.slice(4, 8))).toBe('tEXt');
  expect(String.fromCharCode(...chunk.slice(8, 16))).toBe('Software');
  expect(chunk[16]).toBe(0);
  expect(String.fromCharCode(...chunk.slice(17, 32))).toBe('OpenLiDARViewer');
  expect([...chunk.slice(32, 36)]).toEqual([0x6b, 0xe1, 0x09, 0x5d]);
});

test('encoding with an empty entry list returns the input bytes unchanged', () => {
  const out = encodePngTextChunks(TINY_PNG, []);
  expect([...out]).toEqual([...TINY_PNG]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trips
// ─────────────────────────────────────────────────────────────────────────────

test('multiple entries round-trip in order through encode → read', () => {
  const entries = [
    { keyword: 'Software', text: 'OpenLiDARViewer' },
    { keyword: 'Creation Time', text: '2026-07-12T00:00:00.000Z' },
    { keyword: 'olv:build', text: '0.5.20 (abc1234) · live · built 2026-07-08T18:22:00Z' },
  ];
  const out = encodePngTextChunks(TINY_PNG, entries);
  expect(readPngTextChunks(out)).toEqual(entries);
  // All three ride tEXt (pure ASCII), all before the final IEND.
  expect(chunkTypes(out)).toEqual(['IHDR', 'IDAT', 'tEXt', 'tEXt', 'tEXt', 'IEND']);
});

test('Latin-1-but-not-ASCII text stays in a tEXt chunk and round-trips', () => {
  // é (U+00E9), ± (U+00B1) and ° (U+00B0) are all Latin-1 code points —
  // the PNG spec's tEXt charset — so no iTXt upgrade is needed.
  const entries = [{ keyword: 'olv:camera', text: 'café ±1 m · fov 60.0°' }];
  const out = encodePngTextChunks(TINY_PNG, entries);
  expect(chunkTypes(out)).toEqual(['IHDR', 'IDAT', 'tEXt', 'IEND']);
  expect(readPngTextChunks(out)).toEqual(entries);
});

test('non-Latin-1 text upgrades to an uncompressed iTXt chunk and round-trips', () => {
  // “—” (U+2014) and CJK are outside Latin-1: tEXt cannot carry them
  // losslessly, so the writer must emit iTXt with UTF-8 text instead.
  const entries = [{ keyword: 'olv:crs', text: 'JGD2011 — 平面直角座標系' }];
  const out = encodePngTextChunks(TINY_PNG, entries);
  expect(chunkTypes(out)).toEqual(['IHDR', 'IDAT', 'iTXt', 'IEND']);
  expect(readPngTextChunks(out)).toEqual(entries);
});

test('mixed Latin-1 and UTF-8 entries keep their order on read-back', () => {
  const entries = [
    { keyword: 'Software', text: 'OpenLiDARViewer' },
    { keyword: 'olv:crs', text: '測地系 2011' },
    { keyword: 'olv:colormap', text: 'elevation · viridis' },
  ];
  const out = encodePngTextChunks(TINY_PNG, entries);
  expect(readPngTextChunks(out)).toEqual(entries);
});

// ─────────────────────────────────────────────────────────────────────────────
// Keyword validation (PNG spec: 1–79 printable Latin-1, no edge spaces)
// ─────────────────────────────────────────────────────────────────────────────

test('invalid keywords are rejected loudly instead of writing a corrupt chunk', () => {
  const bad = [
    '',                 // empty
    'k'.repeat(80),     // over the 79-byte spec limit
    ' leading',         // leading space
    'trailing ',        // trailing space
    'olv:∆',            // non-Latin-1 code point
    'nul\u0000key', // NUL would terminate the keyword field early
  ];
  for (const keyword of bad) {
    expect(() => encodePngTextChunks(TINY_PNG, [{ keyword, text: 'x' }])).toThrow();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed inputs
// ─────────────────────────────────────────────────────────────────────────────

test('a non-PNG payload is rejected by both encode and read', () => {
  const notPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(() => encodePngTextChunks(notPng, [{ keyword: 'Software', text: 'x' }])).toThrow(/PNG/i);
  expect(() => readPngTextChunks(notPng)).toThrow(/PNG/i);
});

test('a PNG truncated before IEND is rejected rather than appended to blindly', () => {
  const truncated = TINY_PNG.slice(0, IEND_OFFSET); // signature + IHDR + IDAT only
  expect(() => encodePngTextChunks(truncated, [{ keyword: 'Software', text: 'x' }])).toThrow(/IEND/i);
});

test('the reader surfaces a corrupted text chunk instead of returning bad data', () => {
  const out = encodePngTextChunks(TINY_PNG, [{ keyword: 'Software', text: 'OpenLiDARViewer' }]);
  // Flip one payload byte inside the tEXt chunk — its stored CRC no longer
  // matches, and silently returning the mangled text would defeat the whole
  // point of carrying provenance.
  const corrupt = out.slice();
  corrupt[IEND_OFFSET + 20] ^= 0xff;
  expect(() => readPngTextChunks(corrupt)).toThrow(/CRC/i);
});
