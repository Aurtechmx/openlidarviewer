/**
 * demGeoTiffInlineFields.test.ts — TIFF fields of four bytes or fewer live IN
 * the IFD entry, not at an offset.
 *
 * Classic TIFF stores a field's payload inside the entry's value slot whenever
 * the whole payload fits in four bytes (TIFF 6.0 §2). The writer treated every
 * blob as out-of-line, so a short payload had an OFFSET written where the data
 * belonged and a reader took those four bytes at face value.
 *
 * The live contour support raster is exactly that case: `band: 'uint8'` with
 * `noData: 255` makes the GDAL_NODATA payload `"255\0"`, four bytes on the
 * nose. tifffile failed to parse the tag and reported nodata 0 — and 0 is a
 * REAL class in that product, meaning unsupported/void, not missing data. So a
 * reader could not tell a genuine class-0 cell from a hole.
 *
 * These tests parse the container themselves rather than assuming every payload
 * is an offset, because assuming that is the bug. They deliberately do not
 * depend on a TIFF library: the suite must run wherever the gate runs. The same
 * files were also read with Pillow 12.3.0 and tifffile 2026.3.3 while fixing
 * this, which is where the reader-visible symptom was confirmed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { writeGeoTiff } from '../src/terrain/export/demGeoTiff';

const T_ASCII = 2;
const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8 };
const GDAL_NODATA = 42113;

interface Field { tag: number; type: number; count: number; slot: Uint8Array; offset: number }

/** Parse the first IFD, keeping each entry's raw four value bytes. */
function readFields(bytes: Uint8Array): Map<number, Field> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(String.fromCharCode(bytes[0], bytes[1])).toBe('II');
  expect(dv.getUint16(2, true)).toBe(42);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  const out = new Map<number, Field>();
  for (let i = 0; i < n; i += 1) {
    const p = ifd + 2 + i * 12;
    out.set(dv.getUint16(p, true), {
      tag: dv.getUint16(p, true),
      type: dv.getUint16(p + 2, true),
      count: dv.getUint32(p + 4, true),
      slot: bytes.subarray(p + 8, p + 12),
      offset: dv.getUint32(p + 8, true),
    });
  }
  return out;
}

/** A field's payload, read from the slot or the offset as the spec requires. */
function payload(bytes: Uint8Array, f: Field): Uint8Array {
  const size = (TYPE_BYTES[f.type] ?? 0) * f.count;
  return size <= 4 ? f.slot.subarray(0, size) : bytes.subarray(f.offset, f.offset + size);
}

const ascii = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0+$/, '');

/** The live support raster: three classes, all covered, byte band, NoData 255. */
const supportRaster = (values: number[], coverage: number[], cols: number, rows: number) =>
  writeGeoTiff({
    values: Float64Array.from(values) as unknown as Float64Array,
    coverage: Uint8Array.from(coverage),
    cols, rows, cellSize: 1, xllCorner: 500_000, yllCorner: 4_640_000,
    noData: 255, epsg: 32612, isGeographic: false, band: 'uint8',
  });

describe('GDAL_NODATA on the support raster', () => {
  it('stores the four-byte payload inline, not as an offset', () => {
    const bytes = supportRaster([0, 1, 2], [1, 1, 1], 3, 1);
    const f = readFields(bytes).get(GDAL_NODATA)!;
    expect(f.type).toBe(T_ASCII);
    expect(f.count).toBe(4); // "255\0"
    expect(ascii(payload(bytes, f))).toBe('255');
    // The exact defect: the slot held a small file offset, which readers then
    // decoded as the NoData text.
    expect(f.offset).not.toBeLessThan(0x1000);
  });

  it('keeps all three support classes, 0 among them, distinct from NoData', () => {
    const bytes = supportRaster([0, 1, 2], [1, 1, 1], 3, 1);
    const strip = stripOf(bytes);
    expect(Array.from(strip)).toEqual([0, 1, 2]);
    const f = readFields(bytes).get(GDAL_NODATA)!;
    expect(ascii(payload(bytes, f))).toBe('255');
  });

  it('writes an uncovered cell as 255 while a real 0 stays 0', () => {
    const bytes = supportRaster([0, 1], [1, 0], 2, 1);
    expect(Array.from(stripOf(bytes))).toEqual([0, 255]);
  });
});

describe('the four-byte boundary', () => {
  // One byte either side of the rule, driven through the real writer.
  it.each([
    [7, '7', 2],     // "7\0"
    [99, '99', 3],   // "99\0"
    [255, '255', 4], // "255\0" — exactly the limit, inline
  ])('stores NoData %i inline', (noData, text, count) => {
    const bytes = writeGeoTiff({
      values: Float64Array.from([1]) as unknown as Float64Array,
      coverage: Uint8Array.from([1]),
      cols: 1, rows: 1, cellSize: 1, xllCorner: 0, yllCorner: 0,
      noData, epsg: 32612, isGeographic: false, band: 'uint8',
    });
    const f = readFields(bytes).get(GDAL_NODATA)!;
    expect(f.count).toBe(count);
    expect(ascii(payload(bytes, f))).toBe(text);
  });

  it('stores a five-byte payload at an offset', () => {
    // "1000\0" is five bytes, one past the limit.
    const bytes = writeGeoTiff({
      values: Float64Array.from([1]) as unknown as Float64Array,
      coverage: Uint8Array.from([1]),
      cols: 1, rows: 1, cellSize: 1, xllCorner: 0, yllCorner: 0,
      noData: 1000, epsg: 32612, isGeographic: false,
    });
    const f = readFields(bytes).get(GDAL_NODATA)!;
    expect(f.count).toBe(5);
    expect(f.offset).toBeGreaterThan(8);
    expect(ascii(payload(bytes, f))).toBe('1000');
  });

  it('keeps the Float32 -9999 sentinel readable', () => {
    const bytes = writeGeoTiff({
      values: Float64Array.from([1, 2, 3, 4]) as unknown as Float64Array,
      coverage: Uint8Array.from([1, 1, 0, 1]),
      cols: 2, rows: 2, cellSize: 10, xllCorner: 500_000, yllCorner: 4_640_000,
      epsg: 32612, isGeographic: false,
    });
    const f = readFields(bytes).get(GDAL_NODATA)!;
    expect(ascii(payload(bytes, f))).toBe('-9999');
  });
});

describe('georeferencing and orientation survive the change', () => {
  it('ties the raster to its upper-left corner, north up', () => {
    const bytes = writeGeoTiff({
      values: Float64Array.from([1, 2, 3, 4]) as unknown as Float64Array,
      coverage: Uint8Array.from([1, 1, 1, 1]),
      cols: 2, rows: 2, cellSize: 10, xllCorner: 500_000, yllCorner: 4_640_000,
      epsg: 32612, isGeographic: false,
    });
    const fields = readFields(bytes);
    const scale = new Float64Array(payload(bytes, fields.get(33550)!).slice().buffer);
    expect([scale[0], scale[1]]).toEqual([10, 10]);
    const tie = new Float64Array(payload(bytes, fields.get(33922)!).slice().buffer);
    // Upper-left Y is the lower-left Y plus the raster's height.
    expect([tie[3], tie[4]]).toEqual([500_000, 4_640_000 + 2 * 10]);
    // File row 0 is the NORTH row, so it carries the second grid row.
    const strip = new Float32Array(stripOf(bytes).slice().buffer);
    expect([strip[0], strip[1]]).toEqual([3, 4]);
  });
});

/** The image strip, located through StripOffsets/StripByteCounts. */
function stripOf(bytes: Uint8Array): Uint8Array {
  const fields = readFields(bytes);
  const off = fields.get(273)!.offset;
  const len = fields.get(279)!.offset;
  return bytes.subarray(off, off + len);
}

/**
 * The fixture above is only meaningful while it matches the live caller.
 *
 * `contourDeliverableBuild.ts` is what puts a support raster in a shipped
 * package, and the inline-field defect was reachable precisely because it
 * passes `band: 'uint8'` with `noData: 255`. A source assertion is a weak test
 * on its own; its job here is to fail loudly if that call site changes, so the
 * byte-level cases above are never silently testing parameters nothing uses.
 */
describe('the live support-raster caller', () => {
  it('still builds with the byte band and NoData 255', () => {
    const src = readFileSync(
      new URL('../src/terrain/export/contourDeliverableBuild.ts', import.meta.url), 'utf8',
    );
    const call = src.slice(src.indexOf("bytes.set(\n      'support-raster'"));
    expect(call).toContain('noData: 255');
    expect(call).toContain("band: 'uint8'");
  });
});
