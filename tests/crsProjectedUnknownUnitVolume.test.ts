/**
 * A projected CRS whose linear unit is not known gets no metric verdict.
 *
 * The unit gate (`isLinearUnitKnown`) withholds metric claims for such a CRS,
 * but the measurement verdict passed any projected kind as safe-metric, so the
 * lasso volume printed cubic and square metres at factor 1 and offered Save.
 * Both checks now agree: no metric display, no Save, and a volume refusal.
 * A projected CRS with a known unit, and local coordinates, keep their verdicts.
 */
import { describe, expect, it } from 'vitest';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { validateCrsForMeasurement } from '../src/geo/CrsValidation';
import { spatialContextFrom, volumeClaimRefusal, volumeUnitCaveat } from '../src/geo/SpatialContext';
import { crsFromWkt } from '../src/io/crs';

function memoryPort(): CrsOverridePort {
  const entries = new Map<string, CrsOverride>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: 1 }); },
    clear: (key) => { entries.delete(key); },
  };
}

/** A scan with no declared CRS, then the override a session restore applies. */
function sessionOverride(epsg: number): CrsService {
  const svc = new CrsService(memoryPort());
  svc.resolveForScan({ name: 'scan.laz', detected: undefined, source: 'las-vlr' });
  svc.setOverride({ override: { epsg, kind: 'projected' }, detected: undefined, source: 'user-override', persist: false });
  return svc;
}

/** A WKT1 PROJCS with no UNIT of its own (the GEOGCS unit is angular). */
const PROJCS_NO_UNIT =
  'PROJCS["Site grid",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"]]';

describe('a projected CRS with an unknown linear unit', () => {
  it('a session override of EPSG:90000 refuses the volume and Save', () => {
    const svc = sessionOverride(90000);
    expect(svc.current()!.kind).toBe('projected');
    const ctx = svc.context();
    const verdict = svc.validation();
    expect(ctx.linearUnitKnown).toBe(false);
    expect(ctx.metricClaimsPermitted).toBe(false);
    expect(verdict.validity).not.toBe('safe-metric');
    expect(verdict.canDisplayMetric).toBe(false);
    expect(verdict.canSaveMeasurement).toBe(false);
    expect(volumeClaimRefusal(ctx, verdict)).not.toBeNull();
  });

  it('a WKT1 PROJCS without a UNIT refuses the volume and Save', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'site.laz', detected: crsFromWkt(PROJCS_NO_UNIT), source: 'las-vlr' });
    expect(svc.current()!.kind).toBe('projected');
    const ctx = svc.context();
    const verdict = svc.validation();
    expect(ctx.linearUnitKnown).toBe(false);
    expect(verdict.validity).not.toBe('safe-metric');
    expect(verdict.canDisplayMetric).toBe(false);
    expect(verdict.canSaveMeasurement).toBe(false);
    expect(volumeClaimRefusal(ctx, verdict)).not.toBeNull();
  });

  it('the verdict and the context gate agree', () => {
    const crs: ResolvedCrs = {
      kind: 'projected', name: 'EPSG:90000', epsg: 90000, linearUnit: 'unknown', linearUnitToMetres: 1,
      source: 'user-override', confidence: 'high', userConfirmed: true,
    };
    const verdict = validateCrsForMeasurement(crs);
    expect(verdict.canDisplayMetric).toBe(spatialContextFrom(crs).metricClaimsPermitted);
    expect(verdict.canDisplayMetric).toBe(false);
  });
});

describe('a projected CRS with a known linear unit is unchanged', () => {
  it('EPSG:32612 stays saveable in metres', () => {
    const svc = sessionOverride(32612);
    const crs = svc.current()!;
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
    const verdict = svc.validation();
    expect(verdict.validity).toBe('safe-metric');
    expect(verdict.canDisplayMetric).toBe(true);
    expect(verdict.canSaveMeasurement).toBe(true);
    expect(volumeClaimRefusal(svc.context(), verdict)).toBeNull();
  });

  it('EPSG:2229 stays saveable in US survey feet', () => {
    const svc = sessionOverride(2229);
    const crs = svc.current()!;
    expect(crs.linearUnit).toBe('us-survey-foot');
    expect(crs.linearUnitToMetres).toBe(1200 / 3937);
    const verdict = svc.validation();
    expect(verdict.validity).toBe('safe-metric');
    expect(verdict.canSaveMeasurement).toBe(true);
    expect(volumeClaimRefusal(svc.context(), verdict)).toBeNull();
  });

  it('a unit known by its declared factor stays saveable', () => {
    const verdict = validateCrsForMeasurement({
      kind: 'projected', name: 'Centimetre grid', linearUnit: 'unknown', linearUnitToMetres: 0.01, linearUnitByFactor: true,
      source: 'las-vlr', confidence: 'medium', userConfirmed: false,
    });
    expect(verdict.validity).toBe('safe-metric');
    expect(verdict.canSaveMeasurement).toBe(true);
  });

  it('local coordinates keep the units-assumed-metres verdict', () => {
    const crs: ResolvedCrs = {
      kind: 'local', name: 'Local coordinates (no CRS)', linearUnit: 'unknown', linearUnitToMetres: 1,
      source: 'user-override', confidence: 'high', userConfirmed: true,
    };
    const verdict = validateCrsForMeasurement(crs);
    expect(verdict.validity).toBe('safe-explicit-local');
    expect(verdict.canSaveMeasurement).toBe(true);
    expect(volumeClaimRefusal(spatialContextFrom(crs), verdict)).toBeNull();
    expect(volumeUnitCaveat(spatialContextFrom(crs), verdict.validity)).toBe(' · units assumed metres');
  });
});
