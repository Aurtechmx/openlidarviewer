/**
 * unitLabelHonesty.test.ts: unit labels say what the numbers are in.
 *
 * - Scan Fitness grades the vertical RMSE only when the vertical scale resolved.
 * - The probe readout, the inspector card baked into PNGs and the camera
 *   distance carry the CRS's own units, never a literal " m".
 * - A volume readout says when its heights borrow the horizontal unit.
 * - A profile CSV is refused on a geographic CRS, and a line's grade comes
 *   from its converted run and rise.
 */

import { describe, it, expect } from 'vitest';
import { buildScanFitness, fitnessVerticalRmse, type FitnessInputs } from '../src/terrain/quality/scanFitness';
import { cameraDistanceText, coordTripletText, worldCoordLabels } from '../src/render/pointInfo';
import { spatialContextFrom, volumeUnitCaveat } from '../src/geo/SpatialContext';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { CrsInfo } from '../src/io/crs';
import { lineBreakdown } from '../src/render/measure/measureBreakdown';
import { profileCsvRefusal } from '../src/render/measure/profileSummary';
import { GEOGRAPHIC_CRS_MEASURE_NOTICE } from '../src/render/measure/format';
import { profileMetresPerUnit } from '../src/app/measurePanelMount';

const fitness = (over: Partial<FitnessInputs>): FitnessInputs => ({
  status: 'ready',
  score: 90,
  crsKnown: true,
  datumKnown: true,
  crsName: 'EPSG:32613',
  datumName: 'NAVD88',
  measuredFraction: 0.98,
  groundDensityPerM2: 20,
  verticalRmse: 0.05,
  notSurveyGrade: true,
  unit: 'm',
  unitToMetres: 1,
  unitKnown: true,
  unclassifiedFraction: 0,
  hasGroundClass: true,
  coverageMode: 'full',
  densityReferenceFloor: 'QL2',
  ...over,
} as FitnessInputs);

describe('Scan Fitness vertical accuracy', () => {
  it('withholds the RMSE when the vertical scale did not resolve', () => {
    expect(fitnessVerticalRmse({ verticalScaleResolved: false, validation: { rmse: 0.05 } })).toBeNull();
    expect(fitnessVerticalRmse({ verticalScaleResolved: true, validation: { rmse: 0.05 } })).toBe(0.05);
    expect(fitnessVerticalRmse({ verticalScaleResolved: true, validation: { rmse: Number.NaN } })).toBeNull();
  });

  it('says the accuracy cannot be graded, with no headline or badge', () => {
    const f = buildScanFitness(fitness({ verticalRmse: null, verticalScaleResolved: false }));
    const acc = f.dimensions.find((d) => d.key === 'accuracy')!;
    expect(acc.summary).toBe('Can’t be graded: the vertical unit is not resolved, so the hold-out error is in source Z units.');
    expect(f.headlineAccuracy).toBeNull();
    expect(f.tierBadge).toBeNull();
  });
});

const projected = (unit: 'metre' | 'foot' | 'unknown', vertical?: number): ResolvedCrs =>
  ({ kind: 'projected', name: 'EPSG:2231', linearUnit: unit, linearUnitToMetres: unit === 'foot' ? 0.3048 : 1, verticalUnitToMetres: vertical }) as unknown as ResolvedCrs;
const geographic = ({ kind: 'geographic', name: 'EPSG:4326', linearUnit: 'unknown', linearUnitToMetres: 1 }) as unknown as ResolvedCrs;

describe('probe and inspector coordinate units', () => {
  const p = { x: 1.5, y: 2.5, z: 3.5 };

  it('uses the projected linear unit on every axis', () => {
    expect(coordTripletText(p, worldCoordLabels(projected('foot')))).toBe('1.5 ft, 2.5 ft, 3.5 ft');
  });

  it('shows degrees for X and Y and the vertical unit for Z on a geographic CRS', () => {
    expect(coordTripletText(p, worldCoordLabels(geographic))).toBe('1.5°, 2.5°, 3.5 m');
  });

  it('asserts no unit on an unknown frame', () => {
    expect(coordTripletText(p, worldCoordLabels(undefined))).toBe('1.5, 2.5, 3.5');
  });

  it('labels the camera distance in the real unit only on a projected CRS with a known unit', () => {
    expect(cameraDistanceText(12.34, projected('foot'))).toBe('12.34 ft');
    expect(cameraDistanceText(12.34, projected('metre'))).toBe('12.34 m');
    expect(cameraDistanceText(12.34, projected('unknown'))).toBe('12.34 render units');
    expect(cameraDistanceText(12.34, geographic)).toBe('12.34 render units');
    expect(cameraDistanceText(12.34, undefined)).toBe('12.34 render units');
  });
});

describe('volume readout unit caveat', () => {
  const ctx = (o: Partial<CrsInfo>) =>
    spatialContextFrom({ source: 'epsg', name: 'EPSG:2231', linearUnit: 'foot', linearUnitToMetres: 0.3048, ...o } as CrsInfo);

  it('says the heights borrow the horizontal unit when no vertical unit is declared', () => {
    expect(volumeUnitCaveat(ctx({}), 'safe')).toBe(' · heights assumed in the horizontal unit (vertical unit not declared)');
  });

  it('adds nothing when a vertical unit is declared, and keeps the local-units caveat', () => {
    expect(volumeUnitCaveat(ctx({ verticalUnitToMetres: 0.3048 }), 'safe')).toBe('');
    expect(volumeUnitCaveat(ctx({}), 'safe-explicit-local')).toBe(' · units assumed metres');
  });
});

describe('profile CSV on a geographic CRS', () => {
  it('refuses the export with the geographic notice', () => {
    expect(profileCsvRefusal({ trust: { reasons: [GEOGRAPHIC_CRS_MEASURE_NOTICE] } })).toBe(GEOGRAPHIC_CRS_MEASURE_NOTICE);
    expect(profileCsvRefusal({ trust: { reasons: [] } })).toBeNull();
    expect(profileCsvRefusal({})).toBeNull();
  });

  it('gives the profile section no metres-per-unit factor on a geographic CRS', () => {
    expect(profileMetresPerUnit({ linearUnitKnown: true, linearUnitToMetres: 1, isGeographic: true })).toBeNull();
    expect(profileMetresPerUnit({ linearUnitKnown: true, linearUnitToMetres: 0.3048, isGeographic: false })).toBe(0.3048);
    expect(profileMetresPerUnit({ linearUnitKnown: false, linearUnitToMetres: 1, isGeographic: false })).toBeNull();
  });
});

describe('line grade on a compound CRS', () => {
  it('grades the converted rise over the converted run', () => {
    // 3 m run, 4 ft rise: 1.2192 m over 3 m is 40.64 %.
    const r = lineBreakdown([0, 0, 0], [3, 0, 4], [0, 0, 1], 1, 0.3048);
    expect(r.gradePercent).toBeCloseTo((100 * 4 * 0.3048) / 3, 9);
    expect(r.gradeAngleDeg).toBeCloseTo((Math.atan2(4 * 0.3048, 3) * 180) / Math.PI, 9);
    expect(r.length3dM).toBeCloseTo(Math.hypot(3, 4 * 0.3048), 9);
  });
});
