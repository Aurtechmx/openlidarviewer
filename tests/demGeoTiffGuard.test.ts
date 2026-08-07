/**
 * demGeoTiffGuard.test.ts — the GeoTIFF writer must refuse a short input array.
 *
 * The strip loop reads `input.values[i]` / `input.coverage[i]` for every grid
 * cell. A `values` (or `coverage`) array shorter than rows*cols reads
 * `undefined` past its end → `Number.isFinite(undefined) === false` → the cell
 * is silently written as NODATA. A truncated input would therefore emit a
 * plausible-looking DEM riddled with holes rather than failing loudly — exactly
 * the "silent wrong number in an output file" this project treats as its top
 * risk. Both current callers pass dtm.z-derived cols*rows arrays, so this is a
 * defensive guard for a FUTURE caller, not a live bug.
 */

import { describe, it, expect } from 'vitest';
import { writeGeoTiff, type DemGeoTiffInput } from '../src/terrain/export/demGeoTiff';

/** A well-formed 2×2 grid; individual fields overridden per case. */
function grid(over: Partial<DemGeoTiffInput> = {}): DemGeoTiffInput {
  return {
    values: Float32Array.from([1, 2, 3, 4]),
    coverage: Uint8Array.from([1, 1, 1, 1]),
    cols: 2,
    rows: 2,
    cellSize: 1,
    xllCorner: 0,
    yllCorner: 0,
    epsg: 32611,
    ...over,
  };
}

describe('writeGeoTiff length guard', () => {
  it('throws a clear error when values is shorter than rows*cols', () => {
    expect(() => writeGeoTiff(grid({ values: Float32Array.from([1, 2, 3]) }))).toThrow(
      /writeGeoTiff.*values.*3.*4/s,
    );
  });

  it('throws when coverage is shorter than rows*cols', () => {
    expect(() => writeGeoTiff(grid({ coverage: Uint8Array.from([1, 1, 1]) }))).toThrow(
      /writeGeoTiff.*coverage/s,
    );
  });

  it('succeeds on a correctly-sized grid and emits a little-endian TIFF', () => {
    const out = writeGeoTiff(grid());
    // 'II' magic + TIFF 42 — proof the writer ran to completion.
    expect(out[0]).toBe(0x49);
    expect(out[1]).toBe(0x49);
    expect(new DataView(out.buffer).getUint16(2, true)).toBe(42);
    expect(out.length).toBeGreaterThan(8);
  });
});
