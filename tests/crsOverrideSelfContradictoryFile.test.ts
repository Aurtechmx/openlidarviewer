/**
 * A file whose own CRS declaration contradicts itself, corrected in the
 * Inspector by picking the file's code with the code's real kind.
 *
 * LAS GeoKeys can say one kind in GTModelType (1024) and carry a code of
 * another kind: model type 1 (projected) with only GeodeticCRSGeoKey
 * 2048=4326, or model type 2 (geographic) with ProjectedCRSGeoKey 3072=32612.
 * Picking the code with its real kind resolved to an unknown CRS whose label
 * named the file's kind as the code's. The EPSG table now decides: when it
 * agrees with the pick, the pick resolves and the label says the file's
 * declaration was contradictory. A pick the table contradicts stays unknown.
 */
import { describe, expect, it } from 'vitest';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import { crsFromGeoTiff, crsFromWkt, type CrsInfo } from '../src/io/crs';

function memoryPort(): CrsOverridePort {
  const entries = new Map<string, CrsOverride>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: 1 }); },
    clear: (key) => { entries.delete(key); },
  };
}

/** A GeoKeyDirectory payload from [key, value] pairs (all inline shorts). */
function geoKeys(keys: readonly (readonly [number, number])[]): Uint8Array {
  const u = new Uint16Array(4 + keys.length * 4);
  u.set([1, 1, 0, keys.length]);
  keys.forEach(([k, v], i) => u.set([k, 0, 1, v], 4 + i * 4));
  return new Uint8Array(u.buffer);
}

/** Model type 1 (projected) with the geographic code 4326 in key 2048. */
const PROJECTED_TYPE_GEOGRAPHIC_CODE = crsFromGeoTiff(geoKeys([[1024, 1], [2048, 4326]]), null, null);
/** Model type 2 (geographic) with the projected code 32612 in key 3072. */
const GEOGRAPHIC_TYPE_PROJECTED_CODE = crsFromGeoTiff(geoKeys([[1024, 2], [3072, 32612]]), null, null);

const GEOCENTRIC = 'GEOCCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["metre",1],AXIS["Geocentric X",OTHER],AXIS["Geocentric Y",OTHER],AXIS["Geocentric Z",NORTH],AUTHORITY["EPSG","4978"]]';
const UTM = 'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]]';
const WGS84 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';

/** Open a file, then pick `epsg` as `kind` in the Inspector (persisted). */
function pick(detected: CrsInfo, epsg: number, kind: 'projected' | 'geographic', persist = true): CrsService {
  const svc = new CrsService(memoryPort());
  svc.resolveForScan({ name: 'f.las', detected, source: 'las-vlr' });
  svc.setOverride({ override: { epsg, kind }, detected, source: 'user-override', persist });
  return svc;
}

describe('the fixtures contradict themselves', () => {
  it('model type 1 with 2048=4326 reads as a projected CRS with code 4326', () => {
    expect(PROJECTED_TYPE_GEOGRAPHIC_CODE.isGeographic).toBe(false);
    expect(PROJECTED_TYPE_GEOGRAPHIC_CODE.epsg).toBe(4326);
  });

  it('model type 2 with 3072=32612 reads as a geographic CRS with code 32612', () => {
    expect(GEOGRAPHIC_TYPE_PROJECTED_CODE.isGeographic).toBe(true);
    expect(GEOGRAPHIC_TYPE_PROJECTED_CODE.epsg).toBe(32612);
  });
});

describe('picking the file\'s own code with its real kind resolves', () => {
  it('4326 picked as geographic on the model-type-1 file', () => {
    const svc = pick(PROJECTED_TYPE_GEOGRAPHIC_CODE, 4326, 'geographic');
    const crs = svc.current()!;
    expect(crs.kind).toBe('geographic');
    expect(crs.epsg).toBe(4326);
    expect(crs.linearUnit).toBe('unknown');
    expect(crs.name).toBe('WGS 84 (lat / lon) (the file declares EPSG:4326 as projected; the code is geographic)');
    expect(crs.name).not.toContain('the code is a projected CRS');
    expect(svc.context().isGeographic).toBe(true);
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });

  it('32612 picked as projected on the model-type-2 file', () => {
    const svc = pick(GEOGRAPHIC_TYPE_PROJECTED_CODE, 32612, 'projected');
    const crs = svc.current()!;
    expect(crs.kind).toBe('projected');
    expect(crs.epsg).toBe(32612);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(crs.name).toBe('WGS 84 / UTM zone 12N (the file declares EPSG:32612 as geographic; the code is projected)');
    expect(crs.wkt).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(true);
  });

  it('the same pick restored from a session (not persisted) resolves alike', () => {
    const crs = pick(GEOGRAPHIC_TYPE_PROJECTED_CODE, 32612, 'projected', false).current()!;
    expect(crs.kind).toBe('projected');
    expect(crs.linearUnit).toBe('metre');
  });
});

describe('a wrong-kind pick still resolves unknown, with a true label', () => {
  it('4326 picked as projected on the model-type-1 file', () => {
    const svc = pick(PROJECTED_TYPE_GEOGRAPHIC_CODE, 4326, 'projected');
    const crs = svc.current()!;
    expect(crs.kind).toBe('unknown');
    expect(crs.name).toBe('EPSG:4326 (the code is a geographic CRS, not projected)');
    expect(crs.epsg).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });

  it('32612 picked as geographic on the model-type-2 file', () => {
    const svc = pick(GEOGRAPHIC_TYPE_PROJECTED_CODE, 32612, 'geographic');
    const crs = svc.current()!;
    expect(crs.kind).toBe('unknown');
    expect(crs.name).toBe('EPSG:32612 (the code is a projected CRS, not geographic)');
    expect(crs.epsg).toBeUndefined();
  });
});

describe('a consistent file with a wrong-kind pick still fails closed', () => {
  it('a 4326 file restored as projected', () => {
    const svc = pick(crsFromWkt(WGS84), 4326, 'projected', false);
    expect(svc.current()!.kind).toBe('unknown');
    expect(svc.current()!.name).toBe('EPSG:4326 (the code is a geographic CRS, not projected)');
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });

  it('a 32612 file restored as geographic', () => {
    const svc = pick(crsFromWkt(UTM), 32612, 'geographic', false);
    expect(svc.current()!.kind).toBe('unknown');
    expect(svc.current()!.name).toBe('EPSG:32612 (the code is a projected CRS, not geographic)');
  });

  it('a geocentric 4978 file restored as projected', () => {
    const svc = pick(crsFromWkt(GEOCENTRIC), 4978, 'projected', false);
    expect(svc.current()!.kind).toBe('unknown');
    expect(svc.current()!.name).toBe('EPSG:4978 (the code is a geocentric CRS, not projected)');
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });
});
