/**
 * demNoDataSentinel.test.ts — a measured height must never be written as the
 * NoData value.
 *
 * The DEM rasters declared NoData -9999 whatever the heights were. A covered
 * cell at -9999, or at a value that rounds to it (float32 in the GeoTIFF,
 * three decimals in the ASCII grid), was then read as missing. Deep
 * bathymetry in feet reaches that depth. The writers now pick a sentinel no
 * written value equals, keep -9999 when nothing collides, and refuse a
 * caller-given sentinel that collides.
 *
 * `demGeoTiffGdal.test.ts` reads the same cases back with GDAL.
 */

import { describe, it, expect } from 'vitest';
import { writeGeoTiff } from '../src/terrain/export/demGeoTiff';
import { writeAsciiGrid } from '../src/terrain/export/demAsciiGrid';
import { chooseNoData, NoDataCollisionError, DEFAULT_NO_DATA } from '../src/terrain/export/demNoData';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import { sha256Hex } from '../src/terrain/export/sha256';
import { extractEntry } from './helpers/zipReader';
import { DEM_PKG_OPTS, demResultFor } from './helpers/demPackageFixture';

/** GDAL_NODATA text of a GeoTIFF. */
function gdalNoData(bytes: Uint8Array): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    if (dv.getUint16(p, true) !== 42113) continue;
    const count = dv.getUint32(p + 4, true);
    const at = count <= 4 ? p + 8 : dv.getUint32(p + 8, true);
    return new TextDecoder().decode(bytes.subarray(at, at + count)).replace(/\0+$/, '');
  }
  throw new Error('no GDAL_NODATA');
}

/** Float32 samples of a single-strip GeoTIFF, file order. */
function samples(bytes: Uint8Array): number[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  let off = 0; let len = 0;
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    const tag = dv.getUint16(p, true);
    if (tag === 273) off = dv.getUint32(p + 8, true);
    if (tag === 279) len = dv.getUint32(p + 8, true);
  }
  return Array.from({ length: len / 4 }, (_, i) => dv.getFloat32(off + i * 4, true));
}

const geo = { cols: 2, rows: 1, cellSize: 1, xllCorner: 0, yllCorner: 0, epsg: 32612 };
const both = new Uint8Array([1, 1]);
const COLLIDING = [[-9999, 100], [-9998.9996, 100], [-9999.0003, 100]];

describe('the GeoTIFF NoData value never equals a written height', () => {
  for (const values of COLLIDING) {
    it(`moves the sentinel off -9999 for [${values}]`, () => {
      const bytes = writeGeoTiff({ ...geo, values: Float32Array.from(values), coverage: both });
      const nd = Number(gdalNoData(bytes));
      expect(nd).not.toBe(-9999);
      for (const s of samples(bytes)) expect(s).not.toBe(Math.fround(nd));
    });
  }

  it('checks every band that shares the declaration', () => {
    const bytes = writeGeoTiff({
      ...geo,
      bands: [{ values: Float32Array.from([-9999, 1]) }, { values: Float32Array.from([5, -9998.9996]) }],
      coverage: both,
    });
    const nd = Math.fround(Number(gdalNoData(bytes)));
    expect(samples(bytes).filter((s) => s === nd)).toEqual([]);
  });

  it('keeps -9999, and the bytes, when no height collides', () => {
    const a = writeGeoTiff({ ...geo, values: Float32Array.from([-9998.5, 100]), coverage: both });
    const b = writeGeoTiff({ ...geo, values: Float32Array.from([-9998.5, 100]), coverage: both, noData: -9999 });
    expect(gdalNoData(a)).toBe('-9999');
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });

  it('refuses a caller-given sentinel that a height equals', () => {
    expect(() => writeGeoTiff({ ...geo, values: Float32Array.from([-9999, 100]), coverage: both, noData: -9999 }))
      .toThrow(NoDataCollisionError);
  });

  it('ignores uncovered cells', () => {
    const bytes = writeGeoTiff({ ...geo, values: Float32Array.from([-9999, 100]), coverage: new Uint8Array([0, 1]) });
    expect(gdalNoData(bytes)).toBe('-9999');
  });
});

describe('the ASCII grid NoData value never equals a written height', () => {
  for (const values of COLLIDING) {
    it(`moves the sentinel off -9999 for [${values}]`, () => {
      const text = writeAsciiGrid({ ...geo, values, coverage: both });
      const nd = Number(/NODATA_value (\S+)/.exec(text)![1]);
      expect(nd).not.toBe(-9999);
      const cells = text.trim().split('\n').slice(6).join(' ').split(/\s+/).map(Number);
      expect(cells).not.toContain(nd);
    });
  }

  it('keeps -9999 for the control [-9998.5, 100]', () => {
    expect(writeAsciiGrid({ ...geo, values: [-9998.5, 100], coverage: both })).toContain('NODATA_value -9999\n');
  });

  it('refuses a caller-given sentinel that a height rounds to', () => {
    expect(() => writeAsciiGrid({ ...geo, values: [-9999.0003, 100], coverage: both, noData: -9999 }))
      .toThrow(NoDataCollisionError);
  });
});

describe('chooseNoData', () => {
  it('returns -9999 when nothing collides', () => {
    expect(chooseNoData([{ values: [1, 2], coverage: both }])).toBe(DEFAULT_NO_DATA);
  });

  it('goes below every written value with a float32-exact integer', () => {
    const nd = chooseNoData([{ values: [-9999, 100], coverage: both }]);
    expect(nd).toBeLessThan(-9999);
    expect(Math.fround(nd)).toBe(nd);
    expect(Number.isInteger(nd)).toBe(true);
  });

  it('falls back to the most negative float32 below the float32-exact integers', () => {
    const nd = chooseNoData([{ values: [-9999, -5e7], coverage: both }]);
    expect(nd).toBe(-3.4028234663852886e38);
  });
});

describe('the DEM package shares one sentinel across its rasters and README', () => {
  function pkg(z: number[]) {
    const g = {
      z: Float32Array.from(z), counts: new Uint32Array(4).fill(3), coverage: new Uint8Array(4).fill(2),
      confidence: new Float32Array(4).fill(100), interpDistanceCells: new Float32Array(4),
      cols: 2, rows: 2, cellSizeM: 1, originH1: 0, originH2: 0,
    };
    const zip = buildDemPackage(demResultFor(g, 1), DEM_PKG_OPTS);
    const get = (n: string) => extractEntry(zip, n)!;
    return { get, readme: new TextDecoder().decode(get('terrain-README.txt')) };
  }

  it('writes a moved sentinel into the GeoTIFFs, the ASCII grids and the README', () => {
    const p = pkg([-9999.0003, 100, 101, 102]);
    const nd = gdalNoData(p.get('terrain-dtm.tif'));
    expect(Number(nd)).not.toBe(-9999);
    for (const k of ['dtm', 'dsm', 'chm']) {
      expect(gdalNoData(p.get(`terrain-${k}.tif`))).toBe(nd);
      expect(new TextDecoder().decode(p.get(`terrain-${k}.asc`))).toContain(`NODATA_value ${nd}\n`);
    }
    expect(gdalNoData(p.get('terrain_evidence.tif'))).toBe(nd);
    expect(p.readme).toContain(`NODATA value   ${nd}`);
  });

  it('keeps -9999 everywhere for ordinary heights', () => {
    const p = pkg([100, 101, 102, 103]);
    expect(gdalNoData(p.get('terrain-dtm.tif'))).toBe('-9999');
    expect(p.readme).toContain('NODATA value   -9999');
  });
});
