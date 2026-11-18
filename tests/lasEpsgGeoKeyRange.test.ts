/**
 * lasEpsgGeoKeyRange.test.ts — a LAS GeoKey names an EPSG code only for a code
 * in the GeoTIFF range 1024..32766. 32767 is user-defined and 32768..65535 are
 * private (OGC 19-008r4), so those are not written as an EPSG code.
 */
import { describe, it, expect } from 'vitest';
import { writeLas, writeLas14 } from '../src/convert/writeLas';
import { isGeoTiffEpsgCode } from '../src/convert/epsg';
import { convertCloud } from '../src/convert/convertCloud';
import { wktForEpsg } from '../src/io/epsgWkt';
import { PointCloud } from '../src/model/PointCloud';
import type { GlobalPoints } from '../src/convert/globalPoints';

const g = (): GlobalPoints => ({
  count: 3,
  x: Float64Array.from([500000.1, 500001.5, 500002]),
  y: Float64Array.from([4100000, 4100000.25, 4100001]),
  z: Float64Array.from([12.34, 13, 14.5]),
});

function geoKeys(bytes: Uint8Array): Map<number, number> | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = v.getUint16(94, true);
  const nVlr = v.getUint32(100, true);
  for (let i = 0; i < nVlr; i++) {
    const user = new TextDecoder().decode(bytes.subarray(p + 2, p + 18)).replace(/\0+$/, '');
    const id = v.getUint16(p + 18, true);
    const len = v.getUint16(p + 20, true);
    const body = p + 54;
    if (user === 'LASF_Projection' && id === 34735) {
      const keys = new Map<number, number>();
      const n = v.getUint16(body + 6, true);
      for (let k = 0; k < n; k++) keys.set(v.getUint16(body + 8 + k * 8, true), v.getUint16(body + 8 + k * 8 + 6, true));
      return keys;
    }
    p = body + len;
  }
  return null;
}

const text = (b: Uint8Array): string => new TextDecoder('latin1').decode(b);

describe('isGeoTiffEpsgCode', () => {
  it('accepts integers 1024..32766 only', () => {
    for (const c of [1024, 4326, 32612, 32766]) expect(isGeoTiffEpsgCode(c)).toBe(true);
    for (const c of [1023, 32767, 32768, 40000, 65535, 70000, 1024.5, Number.NaN, 0, -1]) {
      expect(isGeoTiffEpsgCode(c)).toBe(false);
    }
    expect(isGeoTiffEpsgCode(null)).toBe(false);
    expect(isGeoTiffEpsgCode(undefined)).toBe(false);
  });
});

describe('LAS 1.2 projected CS key', () => {
  it('writes 32612 unchanged', () => {
    const k = geoKeys(writeLas(g(), { epsg: 32612, isGeographic: false, linearUnitCode: 9001 }));
    expect(k?.get(3072)).toBe(32612);
  });

  for (const code of [32767, 40000, 65535, 32612.5]) {
    it(`writes no EPSG key for ${code}`, () => {
      const k = geoKeys(writeLas(g(), { epsg: code, isGeographic: false, linearUnitCode: 9001 }));
      expect(k?.has(3072) ?? false).toBe(false);
      expect(k?.has(2048) ?? false).toBe(false);
    });
  }
});

describe('LAS 1.4', () => {
  it('keeps the WKT and writes no EPSG key for 40000', () => {
    const wkt = wktForEpsg(32612) as string;
    const bytes = writeLas14(g(), { epsg: 40000, isGeographic: false, wkt });
    expect(geoKeys(bytes)?.has(3072) ?? false).toBe(false);
    expect(text(bytes)).toContain('PROJCS');
  });
});

describe('convertCloud LAS 1.2 export of an out-of-range code', () => {
  const cloud = (): PointCloud =>
    new PointCloud({
      positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 40, 2]),
      origin: [500000, 4000000, 100],
      sourceFormat: 'las',
      name: 'survey.las',
    });

  for (const code of [32767, 40000, 65535]) {
    it(`does not write EPSG:${code} as a CRS`, () => {
      const { file, report } = convertCloud(cloud(), { format: 'las', crsMode: 'assign', targetEpsg: code });
      // A code with no known kind or unit is refused; if it were ever accepted
      // the file would carry no EPSG key.
      if (file) expect(geoKeys(file.bytes)?.has(3072) ?? false).toBe(false);
      else expect(report.ok).toBe(false);
    });
  }
});
