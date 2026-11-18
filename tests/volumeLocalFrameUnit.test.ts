/**
 * A local or engineering frame with no declared unit states no cubic metres.
 *
 * The measurement verdict let a local frame through with "measurements assume
 * the source units are metres", and the lasso volume printed m³ with a
 * "units assumed metres" caveat over coordinates in an unknown unit. The
 * volume is now refused with a message that says the unit is not declared. A
 * local frame that declares its unit (a LOCAL_CS in US survey feet, an ENGCRS
 * in metres) keeps its figures, converted by that unit, and is no longer
 * labelled as assuming metres.
 */
import { describe, expect, it } from 'vitest';
import { localCrs, resolvedFromCrsInfo, type ResolvedCrs } from '../src/geo/CoordinateTypes';
import { validateCrsForMeasurement } from '../src/geo/CrsValidation';
import { spatialContextFrom, volumeClaimRefusal, volumeUnitCaveat } from '../src/geo/SpatialContext';
import { crsFromWkt } from '../src/io/crs';

const FT_US = 1200 / 3937;

const LOCAL_NO_UNIT = 'LOCAL_CS["Site grid",LOCAL_DATUM["Site",0],AXIS["X",EAST],AXIS["Y",NORTH]]';
const LOCAL_FTUS = 'LOCAL_CS["Site grid (ftUS)",LOCAL_DATUM["Site",0],UNIT["US survey foot",0.304800609601219],AXIS["X",EAST],AXIS["Y",NORTH]]';
const ENG_METRE = 'ENGCRS["Plant A",EDATUM["A"],CS[Cartesian,2],AXIS["x",east],AXIS["y",north],LENGTHUNIT["metre",1]]';

const resolve = (wkt: string): ResolvedCrs => resolvedFromCrsInfo(crsFromWkt(wkt), 'las-vlr')!;

describe('a local frame with no declared unit withholds the volume', () => {
  it.each([
    ['the generic local frame', localCrs()],
    ['a LOCAL_CS with no UNIT', resolve(LOCAL_NO_UNIT)],
  ])('%s', (_label, crs) => {
    expect(crs.kind).toBe('local');
    expect(crs.linearUnit).toBe('unknown');
    const verdict = validateCrsForMeasurement(crs);
    expect(verdict.canDisplayMetric).toBe(false);
    expect(verdict.canSaveMeasurement).toBe(false);
    expect(verdict.reason).toBe('Local coordinates with no declared unit; metric measurements are withheld.');
    expect(verdict.reason).not.toMatch(/assume/i);
    const refusal = volumeClaimRefusal(spatialContextFrom(crs), verdict);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('no declared unit');
    expect(spatialContextFrom(crs).metricClaimsPermitted).toBe(false);
  });
});

describe('a local frame with a declared unit keeps working, converted', () => {
  it('a LOCAL_CS in US survey feet', () => {
    const crs = resolve(LOCAL_FTUS);
    expect(crs.kind).toBe('local');
    expect(crs.linearUnit).toBe('us-survey-foot');
    const ctx = spatialContextFrom(crs);
    expect(ctx.linearUnitToMetres).toBe(FT_US);
    expect(ctx.metricClaimsPermitted).toBe(true);
    const verdict = validateCrsForMeasurement(crs);
    expect(verdict.validity).toBe('safe-explicit-local');
    expect(verdict.canDisplayMetric).toBe(true);
    expect(verdict.canSaveMeasurement).toBe(true);
    expect(verdict.reason).toBe('Local coordinates in US survey feet; measurements are converted from the declared unit.');
    expect(volumeClaimRefusal(ctx, verdict)).toBeNull();
    expect(volumeUnitCaveat(ctx)).not.toContain('units assumed metres');
  });

  it('an ENGCRS in metres', () => {
    const crs = resolve(ENG_METRE);
    expect(crs.kind).toBe('local');
    const ctx = spatialContextFrom(crs);
    const verdict = validateCrsForMeasurement(crs);
    expect(verdict.canDisplayMetric).toBe(true);
    expect(volumeClaimRefusal(ctx, verdict)).toBeNull();
    expect(volumeUnitCaveat(ctx)).toBe(' · heights assumed in the horizontal unit (vertical unit not declared)');
  });

  it('a local frame known by its factor alone (centimetres)', () => {
    const crs: ResolvedCrs = {
      kind: 'local', name: 'Site grid (cm)', linearUnit: 'unknown', linearUnitToMetres: 0.01, linearUnitByFactor: true,
      source: 'las-vlr', confidence: 'high', userConfirmed: false,
    };
    const verdict = validateCrsForMeasurement(crs);
    expect(verdict.canDisplayMetric).toBe(true);
    expect(verdict.reason).toBe('Local coordinates in a unit of 0.01 m; measurements are converted from the declared unit.');
    expect(volumeClaimRefusal(spatialContextFrom(crs), verdict)).toBeNull();
  });
});
