/**
 * changeRaster.test.ts — the ESRI ASCII serializer for the change difference:
 * header fields, NODATA for NaN, and the south-first → north-first row flip.
 */

import { describe, it, expect } from 'vitest';
import { NoDataCollisionError } from '../src/terrain/export/demNoData';
import { changeToEsriAscii, changeRasterSidecars, packageChangeRaster, ChangeRasterRefusal } from '../src/terrain/change/changeRaster';

describe('changeToEsriAscii', () => {
  it('writes a valid ESRI ASCII header', () => {
    const diff = new Float32Array([1, 2, 3, 4]); // 2x2
    const asc = changeToEsriAscii({ diff, ncols: 2, nrows: 2, cellSizeM: 0.5, xllCorner: 100, yllCorner: 200 });
    expect(asc).toContain('ncols 2');
    expect(asc).toContain('nrows 2');
    expect(asc).toContain('xllcorner 100');
    expect(asc).toContain('yllcorner 200');
    expect(asc).toContain('cellsize 0.5');
    expect(asc).toContain('NODATA_value -9999');
  });

  it('flips rows to north-first (last grid row is written first)', () => {
    // Grid (south row first): row0 = [1,2], row1 = [3,4]. ESRI north-first → 3 4 then 1 2.
    const diff = new Float32Array([1, 2, 3, 4]);
    const asc = changeToEsriAscii({ diff, ncols: 2, nrows: 2, cellSizeM: 1, xllCorner: 0, yllCorner: 0 });
    const dataRows = asc.trimEnd().split('\n').slice(6); // after 6 header lines
    expect(dataRows[0]).toBe('3 4');
    expect(dataRows[1]).toBe('1 2');
  });

  it('writes NODATA for NaN (incomparable) cells', () => {
    const diff = new Float32Array([1, NaN, NaN, 4]);
    const asc = changeToEsriAscii({ diff, ncols: 2, nrows: 2, cellSizeM: 1, xllCorner: 0, yllCorner: 0, nodata: -9999 });
    const dataRows = asc.trimEnd().split('\n').slice(6);
    // north-first: row1 [NaN,4] then row0 [1,NaN]
    expect(dataRows[0]).toBe('-9999 4');
    expect(dataRows[1]).toBe('1 -9999');
  });

  const base = { ncols: 2, nrows: 1, cellSizeM: 1, xllCorner: 0, yllCorner: 0 };
  const header = (asc: string): Record<string, string> =>
    Object.fromEntries(asc.split('\n').slice(0, 6).map((l) => l.split(' ')));

  it('keeps a geographic cell size and origin at full precision', () => {
    const asc = changeToEsriAscii({ diff: new Float32Array([1, 2]), ...base, cellSizeM: 0.000002245777937, xllCorner: -99.1234567, yllCorner: 19.4326077 });
    const h = header(asc);
    expect(Number(h.cellsize)).toBe(0.000002245777937);
    expect(Number(h.xllcorner)).toBe(-99.1234567);
    expect(Number(h.yllcorner)).toBe(19.4326077);
  });

  it('preserves a 0.0004 difference', () => {
    const asc = changeToEsriAscii({ diff: new Float32Array([0.0004, -0.0004]), ...base });
    const [a, b] = asc.trimEnd().split('\n')[6].split(' ').map(Number);
    expect(Math.fround(a)).toBe(Math.fround(0.0004));
    expect(Math.fround(b)).toBe(Math.fround(-0.0004));
  });

  it('round-trips every Float32 cell exactly', () => {
    const diff = new Float32Array([1 / 3, -123456.78, 1e-7, 0]);
    const asc = changeToEsriAscii({ diff, ...base, ncols: 4 });
    const cells = asc.trimEnd().split('\n')[6].split(' ').map(Number);
    expect(cells.map(Math.fround)).toEqual(Array.from(diff));
  });

  it('moves NODATA when a real difference is -9999', () => {
    const asc = changeToEsriAscii({ diff: new Float32Array([-9999, NaN]), ...base });
    const h = header(asc);
    expect(Number(h.NODATA_value)).toBeLessThan(-9999);
    const [real, empty] = asc.trimEnd().split('\n')[6].split(' ');
    expect(Number(real)).toBe(-9999);
    expect(empty).toBe(h.NODATA_value);
  });

  it('refuses a given NODATA that a real difference reads back as', () => {
    expect(() => changeToEsriAscii({ diff: new Float32Array([-9999, 1]), ...base, nodata: -9999 })).toThrow(NoDataCollisionError);
  });

  it('rejects invalid input', () => {
    const d = new Float32Array([1, 2]);
    expect(() => changeToEsriAscii({ diff: d, ...base, cellSizeM: 0 })).toThrow(/cellSizeM/);
    expect(() => changeToEsriAscii({ diff: d, ...base, cellSizeM: NaN })).toThrow(/cellSizeM/);
    expect(() => changeToEsriAscii({ diff: d, ...base, ncols: 1.5 })).toThrow(/positive integers/);
    expect(() => changeToEsriAscii({ diff: d, ...base, nrows: 0 })).toThrow(/positive integers/);
    expect(() => changeToEsriAscii({ diff: d, ...base, ncols: 3 })).toThrow(/difference values/);
    expect(() => changeToEsriAscii({ diff: d, ...base, xllCorner: Infinity })).toThrow(/origin/);
    expect(() => changeToEsriAscii({ diff: d, ...base, yllCorner: NaN })).toThrow(/origin/);
  });
});

describe('changeRasterSidecars', () => {
  const common = { valueUnit: 'metre', beforeScan: 'a.laz', afterScan: 'b.laz', nodata: -9999 };

  it('writes the .prj and a metadata file for a projected CRS', () => {
    const out = changeRasterSidecars({ ...common, crs: { kind: 'projected', name: 'WGS 84 / UTM zone 14N', epsg: 32614 } });
    expect(out.prj).toContain('UTM zone 14N');
    expect(out.metadata).toContain('CRS: WGS 84 / UTM zone 14N');
    expect(out.metadata).toContain('EPSG: 32614');
    expect(out.metadata).toContain('Cell value unit: metre');
    expect(out.metadata).toContain('after minus before (positive = gain)');
    expect(out.metadata).toContain('Before scan: a.laz');
    expect(out.metadata).toContain('After scan: b.laz');
  });

  it('uses the declared WKT when given', () => {
    const out = changeRasterSidecars({ ...common, crs: { kind: 'geographic', name: 'Custom', wkt: 'GEOGCS["Custom"]' } });
    expect(out.prj).toBe('GEOGCS["Custom"]');
  });

  it('writes no .prj for local coordinates', () => {
    const out = changeRasterSidecars({ ...common, crs: { kind: 'local', name: 'Local' } });
    expect(out.prj).toBeNull();
    expect(out.metadata).toContain('local coordinates');
  });

  it('refuses an unknown CRS and a CRS with no writable definition', () => {
    expect(() => changeRasterSidecars({ ...common, crs: { kind: 'unknown', name: '?' } })).toThrow(ChangeRasterRefusal);
    expect(() => changeRasterSidecars({ ...common, crs: { kind: 'geographic', name: 'Odd', epsg: 9990 } })).toThrow(/no projection definition/);
    expect(() => changeRasterSidecars({ ...common, crs: { kind: 'projected', name: 'Odd' } })).toThrow(ChangeRasterRefusal);
  });
});

describe('packageChangeRaster', () => {
  const grid = { diff: new Float32Array([1, 2]), ncols: 2, nrows: 1, cellSizeM: 1, xllCorner: 0, yllCorner: 0 };
  const ctx = { valueUnit: 'metre', beforeScan: 'a.laz', afterScan: 'b.laz' };

  it('packages the grid with a .prj and a metadata sidecar', () => {
    const out = packageChangeRaster(grid, { ...ctx, crs: { kind: 'projected', name: 'UTM 14N', epsg: 32614 } });
    expect(out.asc()).toContain('ncols 2');
    expect(out.sidecars.map((f) => f.suffix)).toEqual(['.prj', '-metadata.txt']);
  });

  it('refuses before producing any file when the CRS is unknown or the grid is invalid', () => {
    expect(() => packageChangeRaster(grid, { ...ctx, crs: { kind: 'unknown', name: '?' } })).toThrow(ChangeRasterRefusal);
    expect(() => packageChangeRaster({ ...grid, cellSizeM: 0 }, { ...ctx, crs: { kind: 'local', name: 'L' } })).toThrow(/cellSizeM/);
  });
});
