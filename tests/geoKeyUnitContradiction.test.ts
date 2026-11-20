/**
 * The projected linear unit from GeoKeys: only ProjLinearUnitsGeoKey (3076),
 * and only when it agrees with the unit the EPSG code defines.
 *
 * ProjectedCRSGeoKey 3072=2229 (NAD83 / California zone 5, US survey feet)
 * with 3076=9001 (metre) resolved to metres, and so did 3072=2229 with only
 * GeogLinearUnitsGeoKey 2052=9001, which is the linear unit of a geographic
 * CRS. Every length was 3.28x too large and passed as metric. 2052 is no
 * longer read as a projected unit, and a 3076 the code contradicts resolves
 * to an unknown unit with a note, so metric claims are withheld.
 */
import { describe, expect, it } from 'vitest';
import { crsFromGeoTiff } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';

const FT_US = 1200 / 3937;

/** A GeoKeyDirectory payload from [key, value] pairs (all inline shorts). */
function geoKeys(keys: readonly (readonly [number, number])[]): Uint8Array {
  const u = new Uint16Array(4 + keys.length * 4);
  u.set([1, 1, 0, keys.length]);
  keys.forEach(([k, v], i) => u.set([k, 0, 1, v], 4 + i * 4));
  return new Uint8Array(u.buffer);
}

const read = (keys: readonly (readonly [number, number])[]) => crsFromGeoTiff(geoKeys(keys), null, null);

describe('a 3076 that contradicts the code\'s own unit is withheld', () => {
  it('3072=2229 (US survey feet) with 3076=9001 (metre)', () => {
    const crs = read([[1024, 1], [3072, 2229], [3076, 9001]]);
    expect(crs.linearUnit).toBe('unknown');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(crs.linearUnitByFactor).toBeUndefined();
    expect(crs.linearUnitNote).toBe('ProjLinearUnitsGeoKey (3076) declares metres, but EPSG:2229 is defined in US survey feet; the linear unit is withheld');
    const ctx = spatialContextFrom(crs);
    expect(ctx.linearUnitKnown).toBe(false);
    expect(ctx.metricClaimsPermitted).toBe(false);
  });

  it('3072=2229 with 3076=9002 (international foot)', () => {
    const crs = read([[1024, 1], [3072, 2229], [3076, 9002]]);
    expect(crs.linearUnit).toBe('unknown');
    expect(crs.linearUnitNote).toContain('declares international feet');
  });

  it('3072=32612 (metres) with 3076=9003 (US survey foot)', () => {
    const crs = read([[1024, 1], [3072, 32612], [3076, 9003]]);
    expect(crs.linearUnit).toBe('unknown');
    expect(crs.linearUnitNote).toContain('EPSG:32612 is defined in metres');
  });

  it('a code defined in another unit (EPSG:2066, Clarke\'s links) with 3076=9001', () => {
    const crs = read([[1024, 1], [3072, 2066], [3076, 9001]]);
    expect(crs.linearUnit).toBe('unknown');
    expect(crs.linearUnitNote).toContain('EPSG:2066 is defined in a unit other than metres or feet');
  });
});

describe('GeogLinearUnitsGeoKey (2052) is never the projected unit', () => {
  it('3072=2229 with 2052=9001 and no 3076 does not read as metres', () => {
    const crs = read([[1024, 1], [3072, 2229], [2052, 9001]]);
    expect(crs.linearUnit).not.toBe('metre');
    expect(crs.linearUnit).toBe(read([[1024, 1], [3072, 2229]]).linearUnit);
  });

  it('3072=32612 with 2052=9003 and no 3076 takes the code\'s metres', () => {
    const crs = read([[1024, 1], [3072, 32612], [2052, 9003]]);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
  });
});

describe('a 3076 that agrees with the code is unchanged', () => {
  it('3072=32612 with 3076=9001 is metres', () => {
    const crs = read([[1024, 1], [3072, 32612], [3076, 9001]]);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(crs.linearUnitNote).toBeUndefined();
    expect(spatialContextFrom(crs).metricClaimsPermitted).toBe(true);
  });

  it('3072=2229 with 3076=9003 is US survey feet', () => {
    const crs = read([[1024, 1], [3072, 2229], [3076, 9003]]);
    expect(crs.linearUnit).toBe('us-survey-foot');
    expect(crs.linearUnitToMetres).toBe(FT_US);
    expect(crs.linearUnitNote).toBeUndefined();
  });

  it('a code the EPSG table does not hold keeps its 3076', () => {
    const crs = read([[1024, 1], [3072, 2181], [3076, 9001]]);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitNote).toBeUndefined();
  });

  it('a user-defined projected CRS (3072=32767) keeps its 3076', () => {
    const crs = read([[1024, 1], [3072, 32767], [3076, 9002]]);
    expect(crs.linearUnit).toBe('foot');
  });
});
