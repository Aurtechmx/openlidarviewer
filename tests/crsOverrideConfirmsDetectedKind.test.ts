/**
 * An override that names the file's own EPSG code must also name its kind.
 *
 * The branch that confirms the detected code borrowed the file's unit, name
 * and WKT but kept the override's kind. A session file saying "projected
 * 4978" turned a geocentric file into a projected metre frame, "projected
 * 4269" put a projected label on a geographic WKT, and "geographic 2229" read
 * a foot grid as degrees. A kind that differs from the file's now resolves to
 * an unknown CRS with no code and no WKT, as the other contradictions do.
 */
import { describe, expect, it } from 'vitest';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import { elevationWorkflowRefusal } from '../src/geo/SpatialContext';
import { crsFromWkt } from '../src/io/crs';

function memoryPort(): CrsOverridePort {
  const entries = new Map<string, CrsOverride>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: 1 }); },
    clear: (key) => { entries.delete(key); },
  };
}

const GEOCENTRIC = 'GEOCCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["metre",1],AXIS["Geocentric X",OTHER],AXIS["Geocentric Y",OTHER],AXIS["Geocentric Z",NORTH],AUTHORITY["EPSG","4978"]]';
const NAD83 = 'GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4269"]]';
const FTUS = 'PROJCS["NAD83 / California zone 5 (ftUS)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],UNIT["US survey foot",0.304800609601219],AUTHORITY["EPSG","2229"]]';
const UTM = 'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]]';
const WGS84 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';

/** Open a file that declares `wkt`, then restore a session override of its own code. */
function restore(wkt: string, kind: 'projected' | 'geographic'): CrsService {
  const detected = crsFromWkt(wkt);
  const svc = new CrsService(memoryPort());
  svc.resolveForScan({ name: 'f.laz', detected, source: 'las-vlr' });
  svc.setOverride({ override: { epsg: detected.epsg!, kind }, detected, source: 'user-override', persist: false });
  return svc;
}

describe('an override of the file\'s own code with a different kind resolves unknown', () => {
  it('a geocentric file declaring 4978, restored as projected', () => {
    const svc = restore(GEOCENTRIC, 'projected');
    const crs = svc.current()!;
    expect(crs.kind).toBe('unknown');
    expect(crs.name).toBe('EPSG:4978 (the code is a geocentric CRS, not projected)');
    expect(crs.epsg).toBeUndefined();
    expect(crs.wkt).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(false);
    expect(svc.validation().canSaveMeasurement).toBe(false);
  });

  it('a NAD83 file declaring 4269, restored as projected', () => {
    const svc = restore(NAD83, 'projected');
    const crs = svc.current()!;
    expect(crs.kind).toBe('unknown');
    expect(crs.name).toBe('EPSG:4269 (the code is a geographic CRS, not projected)');
    expect(crs.epsg).toBeUndefined();
    expect(crs.wkt).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });

  it('a 2229 foot file, restored as geographic', () => {
    const svc = restore(FTUS, 'geographic');
    const crs = svc.current()!;
    expect(crs.kind).toBe('unknown');
    expect(crs.name).toBe('EPSG:2229 (the code is a projected CRS, not geographic)');
    expect(crs.epsg).toBeUndefined();
    expect(crs.wkt).toBeUndefined();
    expect(svc.context().isGeographic).toBe(false);
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });
});

describe('an override of the file\'s own code with the same kind is unchanged', () => {
  it('a file declaring 32612, restored as projected', () => {
    const detected = crsFromWkt(UTM);
    const crs = restore(UTM, 'projected').current()!;
    expect(crs.kind).toBe('projected');
    expect(crs.epsg).toBe(32612);
    expect(crs.name).toBe(detected.name);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(crs.wkt).toBe(UTM);
  });

  it('a file declaring 4326, restored as geographic', () => {
    const svc = restore(WGS84, 'geographic');
    const crs = svc.current()!;
    expect(crs.kind).toBe('geographic');
    expect(crs.epsg).toBe(4326);
    expect(crs.wkt).toBe(WGS84);
    expect(svc.context().isGeographic).toBe(true);
  });

  it('a geocentric file opened without an override keeps its elevation refusal', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'g.laz', detected: crsFromWkt(GEOCENTRIC), source: 'las-vlr' });
    expect(svc.current()!.kind).toBe('geocentric');
    expect(elevationWorkflowRefusal(svc.context())).not.toBeNull();
  });
});
