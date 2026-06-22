/**
 * changeRaster.test.ts — the ESRI ASCII serializer for the change difference:
 * header fields, NODATA for NaN, and the south-first → north-first row flip.
 */

import { describe, it, expect } from 'vitest';
import { changeToEsriAscii } from '../src/terrain/change/changeRaster';

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
});
