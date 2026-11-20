/**
 * A projected CRS whose code the EPSG table says is not projected gets no
 * unit, and no override can make it one.
 *
 * GeoKeys with model type 1 (projected) and ProjectedCRSGeoKey 3072 holding
 * the geographic code 4326 or 4269, or the vertical code 5703, plus
 * ProjLinearUnitsGeoKey 3076=9001, resolved to a projected CRS in metres and
 * passed as safe-metric: degrees read as metres. The unit is now withheld with
 * a note. An override that names a code with a kind the table contradicts
 * resolves to an unknown CRS even when the file names the same kind.
 *
 * Model type 1 with only GeodeticCRSGeoKey 2048 and a 3076 is left as it was:
 * the 3076 is an explicit declaration there.
 */
import { describe, expect, it } from 'vitest';
import { CrsService } from '../src/geo/CrsService';
import { geoKeyPayload as geoKeys, memoryPort } from './helpers/crsTestKit';
import { crsFromEpsg, crsFromGeoTiff, type CrsInfo } from '../src/io/crs';

const read = (keys: readonly (readonly [number, number])[]) => crsFromGeoTiff(geoKeys(keys), null, null);

function open(detected: CrsInfo): CrsService {
  const svc = new CrsService(memoryPort());
  svc.resolveForScan({ name: 'f.las', detected, source: 'las-vlr' });
  return svc;
}

describe('3072 holding a code the table says is not projected', () => {
  it.each([
    [4326, 'a geographic CRS'],
    [4269, 'a geographic CRS'],
    [5703, 'a vertical CRS'],
  ])('model type 1 + 3072=%i + 3076=9001 withholds the unit', (epsg, what) => {
    const crs = read([[1024, 1], [3072, epsg], [3076, 9001]]);
    expect(crs.isGeographic).toBe(false);
    expect(crs.linearUnit).toBe('unknown');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(crs.linearUnitNote).toBe(`ProjectedCRSGeoKey (3072) holds EPSG:${epsg}, ${what}, not a projected one; the linear unit is withheld`);
    const svc = open(crs);
    expect(svc.validation().validity).not.toBe('safe-metric');
    expect(svc.validation().canSaveMeasurement).toBe(false);
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });

  it('the same without a 3076 has no unit either, and says why', () => {
    const crs = read([[1024, 1], [3072, 4326]]);
    expect(crs.linearUnit).toBe('unknown');
    expect(crs.linearUnitNote).toContain('holds EPSG:4326, a geographic CRS');
  });

  it('a projected code in 3072 is unchanged', () => {
    const crs = read([[1024, 1], [3072, 32612], [3076, 9001]]);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitNote).toBeUndefined();
  });

  it('model type 1 + 2048=4326 + 3076=9001 (no 3072) is left as it was', () => {
    const crs = read([[1024, 1], [2048, 4326], [3076, 9001]]);
    expect(crs.linearUnit).toBe('metre');
    expect(open(crs).validation().validity).toBe('safe-metric');
  });
});

describe('an override whose kind the table contradicts resolves unknown', () => {
  it('a confirmed "projected 4269" on a file that also says projected 4269', () => {
    const file = read([[1024, 1], [2048, 4269], [3076, 9001]]);
    const svc = open(file);
    svc.setOverride({ override: { epsg: 4269, kind: 'projected' }, detected: file, source: 'user-override' });
    const crs = svc.current()!;
    expect(crs.kind).toBe('unknown');
    expect(crs.name).toBe('EPSG:4269 (the code is a geographic CRS, not projected)');
    expect(crs.epsg).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(false);
    expect(svc.validation().validity).not.toBe('safe-metric');
  });

  it('a confirmed "projected 5703" on a file whose 3072 holds 5703', () => {
    const file = read([[1024, 1], [3072, 5703], [3076, 9001]]);
    const svc = open(file);
    svc.setOverride({ override: { epsg: 5703, kind: 'projected' }, detected: file, source: 'user-override', persist: false });
    expect(svc.current()!.kind).toBe('unknown');
    expect(svc.current()!.name).toBe('EPSG:5703 (the code is a vertical CRS, not projected)');
  });

  it('a session "projected 6349" (a compound code) on a stream that declares 6349', () => {
    const file = crsFromEpsg(6349);
    const svc = open(file);
    svc.setOverride({ override: { epsg: 6349, kind: 'projected' }, detected: file, source: 'user-override', persist: false });
    expect(svc.current()!.kind).toBe('unknown');
    expect(svc.current()!.name).toBe('EPSG:6349 (the code is a compound CRS, not projected)');
  });

  it('a confirmed pick the table agrees with is unchanged', () => {
    const file = read([[1024, 1], [3072, 32612], [3076, 9001]]);
    const svc = open(file);
    svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: file, source: 'user-override' });
    expect(svc.current()!.kind).toBe('projected');
    expect(svc.current()!.linearUnit).toBe('metre');
    expect(svc.context().metricClaimsPermitted).toBe(true);
  });
});
