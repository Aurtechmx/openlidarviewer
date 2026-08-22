/**
 * e57PageChecksums.test.ts
 *
 * The E57 page-checksum contract. Until now `depage` stripped each page's
 * trailing 4 bytes and never looked at them, so a single flipped bit inside a
 * coordinate bytestream produced a plausible-but-wrong point that measured,
 * exported and reported as real. Every structural guard in the reader stays
 * silent on that class of damage — which is the whole reason these tests
 * exist: they pin that corruption is REFUSED, and, just as importantly, that
 * an ordinary padded file is still accepted.
 *
 * Fixtures are built in-process (correct CRC-32C, then a byte flipped) rather
 * than committed as binaries, so each case states its own damage in the source.
 * The two committed fixtures carry the real-file end of the contract.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32c } from '../src/io/e57/crc32c';
import { depage, physicalToLogical } from '../src/io/e57/depage';
import { parseE57Header } from '../src/io/e57/header';
import { parseE57 } from '../src/io/e57/parseE57';

const SIGNATURE = 'ASTM-E57';

/**
 * Wrap logical bytes into physical E57 pages with correct big-endian CRC-32C
 * checksums — the inverse of `depage`, and the shape every case below starts
 * from before damaging a copy. The final page is zero-padded to a full page,
 * which is what real writers do.
 */
function pageify(logical: Uint8Array, pageSize: number): Uint8Array {
  const payload = pageSize - 4;
  const pageCount = Math.max(1, Math.ceil(logical.length / payload));
  const out = new Uint8Array(pageCount * pageSize);
  const view = new DataView(out.buffer);
  for (let p = 0; p < pageCount; p++) {
    const start = p * pageSize;
    out.set(logical.subarray(p * payload, (p + 1) * payload), start);
    view.setUint32(start + payload, crc32c(out, start, start + payload), false);
  }
  return out;
}

/** A deterministic logical body of `n` bytes — recognisable on round-trip. */
function body(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 7 + 11) & 0xff;
  return bytes;
}

/** A copy of `bytes` with one bit flipped at `at`. */
function flip(bytes: Uint8Array, at: number): Uint8Array {
  const copy = bytes.slice();
  copy[at] ^= 0x01;
  return copy;
}

/** The buffer behind a Uint8Array, as the ArrayBuffer the readers take. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

// ── CRC-32C itself ───────────────────────────────────────────────────────────
// Checked against the standard check value rather than against this repo's own
// writer: a checksum verified only by the code that produced it proves nothing.
describe('crc32c', () => {
  it('matches the published CRC-32C check value for "123456789"', () => {
    const input = new Uint8Array([...'123456789'].map((c) => c.charCodeAt(0)));
    expect(crc32c(input)).toBe(0xe3069283);
  });

  it('returns 0 for no bytes', () => {
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });

  it('is Castagnoli, not the IEEE polynomial the ZIP and PNG writers use', () => {
    // The IEEE CRC-32 of "123456789" is 0xCBF43926. Reusing either existing
    // implementation in this repo would have produced that value and rejected
    // every valid E57.
    const input = new Uint8Array([...'123456789'].map((c) => c.charCodeAt(0)));
    expect(crc32c(input)).not.toBe(0xcbf43926);
  });

  it('checksums a range without needing a subarray', () => {
    const bytes = body(64);
    expect(crc32c(bytes, 8, 40)).toBe(crc32c(bytes.subarray(8, 40)));
  });
});

// ── depage: acceptance ───────────────────────────────────────────────────────
describe('depage — valid files', () => {
  it('accepts a multipage file and returns its logical bytes contiguously', () => {
    const logical = body(1020 * 3);
    const { logical: out, pagePayload } = depage(bufferOf(pageify(logical, 1024)), 1024);
    expect(pagePayload).toBe(1020);
    expect(out).toHaveLength(1020 * 3);
    expect([...out]).toEqual([...logical]);
  });

  it('accepts a file whose content ends mid-page, padded out to a full page', () => {
    // The ordinary real-world "partial final page": the logical content stops
    // 500 bytes into the last page and the writer zero-fills the rest, then
    // checksums content and padding together. Over-rejecting this would refuse
    // essentially every E57 in existence, so it is pinned explicitly.
    const content = body(1020 + 500);
    const paged = pageify(content, 1024);
    expect(paged).toHaveLength(2048);
    const { logical } = depage(bufferOf(paged), 1024);
    expect([...logical.subarray(0, content.length)]).toEqual([...content]);
    // The padding survives de-paging as the zeros the writer wrote.
    expect([...logical.subarray(content.length)].every((b) => b === 0)).toBe(true);
  });

  it('accepts a single-page file', () => {
    const paged = pageify(body(16), 1024);
    expect(paged).toHaveLength(1024);
    expect(() => depage(bufferOf(paged), 1024)).not.toThrow();
  });
});

// ── depage: refusal ──────────────────────────────────────────────────────────
describe('depage — corruption is refused', () => {
  const paged = pageify(body(1020 * 3), 1024);

  it('refuses a flipped payload byte and names the page', () => {
    // Page 1, 200 bytes in — the exact damage that used to decode into a
    // plausible-but-wrong coordinate.
    const damaged = flip(paged, 1024 + 200);
    expect(() => depage(bufferOf(damaged), 1024)).toThrow(/page 1 of 3/);
    expect(() => depage(bufferOf(damaged), 1024)).toThrow(/CRC-32C/);
  });

  it('names the page the damage is actually on', () => {
    const damaged = flip(paged, 2048 + 7);
    expect(() => depage(bufferOf(damaged), 1024)).toThrow(/page 2 of 3/);
  });

  it('refuses flipped checksum bytes as readily as flipped payload', () => {
    // A checksum that disagrees with intact data is still a file whose
    // integrity claim cannot be honoured; there is no "probably fine" here.
    const damaged = flip(paged, 1020);
    expect(() => depage(bufferOf(damaged), 1024)).toThrow(/page 0 of 3/);
  });

  it('reports the stored and computed checksums so damage can be located', () => {
    const damaged = flip(paged, 300);
    expect(() => depage(bufferOf(damaged), 1024)).toThrow(/stored 0x[0-9a-f]{8}/);
    expect(() => depage(bufferOf(damaged), 1024)).toThrow(/computed 0x[0-9a-f]{8}/);
  });

  it('refuses a file that is not a whole number of pages', () => {
    // A genuinely short final page: the stored checksum covers bytes that are
    // no longer present, so there is nothing honest to compare it against.
    const truncated = paged.subarray(0, 2048 + 600);
    expect(() => depage(bufferOf(truncated), 1024)).toThrow(/truncated/);
    expect(() => depage(bufferOf(truncated), 1024)).toThrow(/whole number of 1024-byte pages/);
  });

  it('refuses a file missing only its last checksum byte', () => {
    const truncated = paged.subarray(0, paged.length - 1);
    expect(() => depage(bufferOf(truncated), 1024)).toThrow(/truncated/);
  });

  it('rejects a page zeroed wholesale, checksum included', () => {
    // All-zero bytes are not a valid page: CRC-32C of 1020 zeros is not zero.
    const damaged = paged.slice();
    damaged.fill(0, 1024, 2048);
    expect(() => depage(bufferOf(damaged), 1024)).toThrow(/page 1 of 3/);
  });
});

// ── The real committed fixtures, end to end ──────────────────────────────────
const synthetic = readFileSync(
  fileURLToPath(new URL('./fixtures/synthetic.e57', import.meta.url)),
);
const syntheticBytes = new Uint8Array(synthetic);

describe('parseE57 — corruption inside a real E57 file', () => {
  it('parses the committed fixture with every page verified', () => {
    expect(() => parseE57(bufferOf(syntheticBytes))).not.toThrow();
  });

  it('refuses a bit flipped in the XML page', () => {
    // The XML section starts at physical offset 48, so page 0 carries it.
    const header = parseE57Header(bufferOf(syntheticBytes));
    expect(Math.floor(header.xmlPhysicalOffset / header.pageSize)).toBe(0);
    const damaged = flip(syntheticBytes, header.xmlPhysicalOffset + 60);
    expect(() => parseE57(bufferOf(damaged))).toThrow(/page 0 of 2/);
  });

  it('refuses a bit flipped in the CompressedVector page', () => {
    // The point data sits on page 1 of this fixture. Before verification this
    // flip returned a wrong coordinate with no error at all.
    const damaged = flip(syntheticBytes, 1024 + 400);
    expect(() => parseE57(bufferOf(damaged))).toThrow(/page 1 of 2/);
  });

  it('would otherwise have decoded the damaged coordinate silently', () => {
    // The point of the change, stated as a test: the same flip leaves the
    // record count, the section id, the packet header and every bytestream
    // length intact, so nothing downstream of depage has anything to complain
    // about. Only the checksum can tell.
    const good = parseE57(bufferOf(syntheticBytes));
    expect(good.scans[0].recordCount).toBe(8);
    const damaged = flip(syntheticBytes, 1024 + 400);
    expect(damaged).toHaveLength(syntheticBytes.length);
    expect(() => parseE57(bufferOf(damaged))).toThrow(/corrupt/);
  });
});

// ── Header field validation ──────────────────────────────────────────────────
/** A minimal valid 48-byte header, patchable per case. */
function header48(
  fields: Partial<{
    versionMajor: number;
    versionMinor: number;
    filePhysicalLength: bigint;
    xmlPhysicalOffset: bigint;
    xmlLogicalLength: bigint;
    pageSize: bigint;
  }> = {},
): ArrayBuffer {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < SIGNATURE.length; i++) bytes[i] = SIGNATURE.charCodeAt(i);
  view.setUint32(8, fields.versionMajor ?? 1, true);
  view.setUint32(12, fields.versionMinor ?? 0, true);
  view.setBigUint64(16, fields.filePhysicalLength ?? 0n, true);
  view.setBigUint64(24, fields.xmlPhysicalOffset ?? 48n, true);
  view.setBigUint64(32, fields.xmlLogicalLength ?? 100n, true);
  view.setBigUint64(40, fields.pageSize ?? 1024n, true);
  return bytes.buffer;
}

describe('parseE57Header — declared field bounds', () => {
  it('accepts an ordinary header', () => {
    const h = parseE57Header(header48());
    expect(h.pageSize).toBe(1024);
    expect(h.xmlPhysicalOffset).toBe(48);
  });

  it('refuses a page size below the floor', () => {
    expect(() => parseE57Header(header48({ pageSize: 32n }))).toThrow(/invalid page size 32/);
  });

  it('refuses a page size above the ceiling', () => {
    // Unbounded, this drove `depage`'s allocation straight off a cliff.
    expect(() => parseE57Header(header48({ pageSize: 1024n * 1024n + 1n }))).toThrow(
      /invalid page size/,
    );
  });

  it('accepts the ceiling itself', () => {
    expect(parseE57Header(header48({ pageSize: 1024n * 1024n })).pageSize).toBe(1024 * 1024);
  });

  it('refuses a page size that is not a safe integer', () => {
    expect(() => parseE57Header(header48({ pageSize: 2n ** 64n - 1n }))).toThrow(
      /page size .* not a value this reader can represent/,
    );
  });

  it('refuses an XML offset that is not a safe integer', () => {
    expect(() => parseE57Header(header48({ xmlPhysicalOffset: 2n ** 53n }))).toThrow(
      /XML section offset/,
    );
  });

  it('refuses an XML length that is not a safe integer', () => {
    expect(() => parseE57Header(header48({ xmlLogicalLength: 2n ** 60n }))).toThrow(
      /XML section length/,
    );
  });

  it('refuses a file length that is not a safe integer', () => {
    expect(() => parseE57Header(header48({ filePhysicalLength: 2n ** 63n }))).toThrow(
      /file length/,
    );
  });

  it('refuses a file shorter than the length its own header declares', () => {
    expect(() => parseE57Header(header48({ filePhysicalLength: 4096n }))).toThrow(
      /truncated: the header declares 4096 bytes but only 48 are present/,
    );
  });

  it('accepts the committed fixture, whose declared length matches exactly', () => {
    const h = parseE57Header(bufferOf(syntheticBytes));
    expect(h.filePhysicalLength).toBe(syntheticBytes.length);
  });
});

describe('physicalToLogical — checksum-offset alias (M7)', () => {
  const PAGE = 1024; // payload = 1020

  it('maps payload offsets to a unique logical byte', () => {
    expect(physicalToLogical(0, PAGE)).toBe(0);
    expect(physicalToLogical(1019, PAGE)).toBe(1019); // last payload byte of page 0
    expect(physicalToLogical(1024, PAGE)).toBe(1020); // first payload byte of page 1
  });

  it('REFUSES an offset that points into a page checksum (the alias)', () => {
    // physical 1020..1023 are page 0's CRC trailer; the old mapping aliased
    // 1020 → logical 1020, colliding with physical 1024 (page 1 start).
    for (const off of [1020, 1021, 1022, 1023]) {
      expect(() => physicalToLogical(off, PAGE)).toThrow(/checksum/i);
    }
    // The genuine page-1 payload byte still resolves cleanly.
    expect(physicalToLogical(1024, PAGE)).toBe(1020);
  });
});

// ── Format version ───────────────────────────────────────────────────────────
// The header carries a major and a minor version, and both were read and then
// ignored. A file declaring a future major version was parsed under the 1.x
// layout: same fixed header fields, same page geometry, same XML schema. Those
// are exactly what a major revision is free to change, so the decode would
// produce coordinates with nothing attached to say they came from a layout this
// reader does not implement.
describe('parseE57Header — format version', () => {
  it('reads the committed fixture as version 1.0', () => {
    const h = parseE57Header(bufferOf(syntheticBytes));
    expect(h.versionMajor).toBe(1);
    expect(h.versionMinor).toBe(0);
  });

  it('refuses a future major version', () => {
    expect(() => parseE57Header(header48({ versionMajor: 2 }))).toThrow(
      /version 2\.0 is not supported/,
    );
  });

  it('refuses a major version below 1', () => {
    expect(() => parseE57Header(header48({ versionMajor: 0 }))).toThrow(/not supported/);
  });

  it('accepts a higher MINOR version, which the standard keeps compatible', () => {
    const h = parseE57Header(header48({ versionMinor: 7 }));
    expect(h.versionMajor).toBe(1);
    expect(h.versionMinor).toBe(7);
  });
});

// ── Content past the declared file length ────────────────────────────────────
// `filePhysicalLength` was checked in one direction only: a buffer SHORTER than
// the declared length was refused as truncated, and a longer one was de-paged
// whole. Every offset in the file then resolved against a logical buffer that
// included bytes past the end of the file the header describes, so a section
// offset could point outside the declared file and still decode.
describe('parseE57 — content past the declared file length', () => {
  /** Where the fixture's XML states its point-section offset. */
  const OFFSET_ATTRIBUTE = 'fileOffset="1168"';

  /**
   * The committed fixture with a copy of its point-section page appended after
   * the length its header declares, and its XML offset moved onto that copy.
   * The appended page carries a correct CRC-32C, and the declared length is
   * left at the original 2048, so the appended bytes are the only thing outside
   * the declared file.
   */
  function sectionPastDeclaredEnd(): Uint8Array {
    const patched = syntheticBytes.slice();
    const at = Buffer.from(patched).toString('latin1').indexOf(OFFSET_ATTRIBUTE);
    expect(at).toBeGreaterThan(0);
    expect(Math.floor((at + OFFSET_ATTRIBUTE.length) / 1024)).toBe(0);
    // Same digit count, so the XML length and every offset after it are unmoved.
    const moved = '2192';
    for (let i = 0; i < moved.length; i++) {
      patched[at + 'fileOffset="'.length + i] = moved.charCodeAt(i);
    }
    // Page 0 changed, so its checksum has to be rewritten or the file reads as
    // corrupt for a reason that has nothing to do with this case.
    new DataView(patched.buffer, patched.byteOffset, patched.byteLength).setUint32(
      1020,
      crc32c(patched, 0, 1020),
      false,
    );
    const out = new Uint8Array(patched.length + 1024);
    out.set(patched, 0);
    out.set(patched.subarray(1024, 2048), 2048);
    return out;
  }

  it('leaves the declared length at the original file size', () => {
    const bytes = sectionPastDeclaredEnd();
    expect(bytes).toHaveLength(3072);
    expect(parseE57Header(bufferOf(bytes)).filePhysicalLength).toBe(2048);
  });

  it('the appended page passes every check except the declared length', () => {
    // The premise: nothing but the bound rejects these bytes. All three pages
    // checksum, so a refusal below is the declared length doing the work.
    expect(() => depage(bufferOf(sectionPastDeclaredEnd()), 1024)).not.toThrow();
  });

  it('refuses a point section placed past the declared end', () => {
    expect(() => parseE57(bufferOf(sectionPastDeclaredEnd()))).toThrow(
      /past the 2048-byte file/,
    );
  });

  it('still parses the fixture whose section is inside the declared length', () => {
    expect(() => parseE57(bufferOf(syntheticBytes))).not.toThrow();
  });
});
