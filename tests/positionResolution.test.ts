/**
 * positionResolution.test.ts: the rule for a measured value below the step a
 * scan's positions are held at, and every surface that applies it.
 *
 * A step within the 10 mm budget leaves every value standing, a genuine zero
 * included. Over budget, a value smaller than the relevant step is withheld
 * with the reason: never written as a number, never summed, and never replaced
 * by another figure of the same record.
 */
import { describe, expect, it } from 'vitest';
import {
  positionSteps, unresolvedMetricKeys, linearSteps, overBudget, unresolvedHeadline, type AxisSteps,
} from '../src/render/measure/geometry';
import {
  measurementMetrics, measurementsToGeoJSON, unresolvedNote, type MeasurementExportContext,
} from '../src/export/measurementExport';
import { measurementsToFindings } from '../src/export/measurementReport';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { aggregate, CHAIN_UNRESOLVED } from '../src/render/measure/measurementChains';
import { positionStepsResolver } from '../src/app/measurementPositionSteps';
import { float32Spacing } from '../src/geo/inMemoryPrecision';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { IDENTITY_LONLAT } from './helpers/geoJsonLonLat';

const UP: Vec3 = [0, 0, 1];
const FAR = 200_000; // metres from the layer origin: a 15.625 mm step
const NEAR = 1000; // a 0.06 mm step

const m = (kind: Measurement['kind'], points: Vec3[], over: Partial<Measurement> = {}): Measurement =>
  ({ id: `${kind}-${points.length}`, kind, name: kind, closed: kind === 'area', points, ...over }) as Measurement;
const steps = (pts: Vec3[], offset: Vec3 | null = null): AxisSteps => positionSteps(pts, offset)!;

describe('positionSteps and the budget', () => {
  it('reads the Float32 step at each axis, less the layer placement', () => {
    const s = steps([[FAR, 0, 100]]);
    expect(s.x).toBe(float32Spacing(FAR));
    expect(s.x).toBeCloseTo(0.015625, 9);
    // The same point on a layer placed 200 km out is held near its own origin.
    expect(steps([[FAR, 0, 100]], [FAR, 0, 0]).x).toBeLessThan(1e-6);
  });

  it('is within budget near the origin and over it at 200 km', () => {
    expect(overBudget(linearSteps(steps([[NEAR, 0, 0]]), UP, 1))).toBe(false);
    expect(overBudget(linearSteps(steps([[FAR, 0, 0]]), UP, 1))).toBe(true);
  });
});

describe('unresolvedMetricKeys', () => {
  it('keeps a genuine zero in an adequate representation', () => {
    const d = m('distance', [[NEAR, 0, 0], [NEAR, 0, 0]]);
    expect(unresolvedMetricKeys(d, UP, 1, 1, steps(d.points))).toEqual([]);
    expect(measurementMetrics(d, UP, 1, 1, 3, steps(d.points)).length_m).toBe(0);
  });

  it('withholds a separation on the coarse axis whatever its size, and keeps one on a fine axis', () => {
    const collapsed = m('distance', [[FAR, 0, 0], [FAR, 0, 0]]);
    expect(unresolvedMetricKeys(collapsed, UP, 1, 1, steps(collapsed.points))).toEqual(['length_m']);
    expect(measurementMetrics(collapsed, UP, 1, 1, 3, steps(collapsed.points)).length_m).toBeUndefined();
    // Held 15.6 mm apart along X, a 3 m run there can be off by more than 1 cm.
    const alongX = m('distance', [[FAR, 0, 0], [FAR + 3, 0, 0]]);
    expect(measurementMetrics(alongX, UP, 1, 1, 3, steps(alongX.points)).length_m).toBeUndefined();
    // The same run along Y reads Y's fine step.
    const alongY = m('distance', [[FAR, 0, 0], [FAR, 3, 0]]);
    expect(measurementMetrics(alongY, UP, 1, 1, 3, steps(alongY.points)).length_m).toBeCloseTo(3, 2);
  });

  it('keeps a resolved height on a scan that is wide only in X', () => {
    const h = m('height', [[FAR, 0, 100], [FAR, 0, 100.005]]);
    const keys = unresolvedMetricKeys(h, UP, 1, 1, steps(h.points));
    expect(keys).toEqual(['horizontal_m']);
    expect(measurementMetrics(h, UP, 1, 1, 6, steps(h.points)).vertical_m).toBeCloseTo(0.005, 4);
  });

  it('withholds every slope figure when its run or rise is unresolved', () => {
    const s = m('slope', [[FAR, 0, 100], [FAR, 0, 101]]);
    expect(unresolvedMetricKeys(s, UP, 1, 1, steps(s.points)).sort()).toEqual(['angle_deg', 'grade_pct', 'rise_m', 'run_m']);
  });

  it('withholds an area and its perimeter when an edge collapses', () => {
    const a = m('area', [[FAR, 0, 0], [FAR + 10, 0, 0], [FAR + 10, 10, 0], [FAR + 10, 10, 0]]);
    expect(unresolvedMetricKeys(a, UP, 1, 1, steps(a.points)).sort()).toEqual(['area_m2', 'horizontal_area_m2', 'perimeter_m']);
  });

  it('applies the unit: US survey feet are held at a coarser step in metres', () => {
    const ftUS = 1200 / 3937;
    const far = FAR / ftUS; // the same 200 km, in feet
    const d = m('distance', [[far, 0, 0], [far, 0, 0]]);
    const s = linearSteps(steps(d.points), UP, ftUS);
    expect(s.horizontal).toBeCloseTo(float32Spacing(far) * ftUS, 9);
    expect(unresolvedMetricKeys(d, UP, ftUS, ftUS, steps(d.points))).toEqual(['length_m']);
  });

  it('states the step and the way out', () => {
    expect(unresolvedHeadline(steps([[FAR, 0, 0]]), UP, 1)).toBe(
      "not resolved: this scan holds positions about 15.63 mm apart, too coarse for this figure; load a smaller tile to measure it",
    );
  });
});

describe('the step follows the layer a measurement was taken on', () => {
  const points: Vec3[] = [[FAR, 0, 0], [FAR, 0, 0]];
  const owned = m('distance', points, { pickLayers: ['placed'] } as Partial<Measurement>);

  it('reads the owning layer, not whichever is listed first', () => {
    const r = positionStepsResolver([
      { stableId: 'unplaced', projectOffset: null },
      { stableId: 'placed', projectOffset: [FAR, 0, 0] },
    ]);
    // Placed 200 km out, the layer holds these points near its own origin: resolved.
    expect(unresolvedMetricKeys(owned, UP, 1, 1, r(owned))).toEqual([]);
  });

  it('reads the coarser step when a measurement spans two layers', () => {
    const spanning = m('distance', points, { pickLayers: ['placed', 'unplaced'] } as Partial<Measurement>);
    const r = positionStepsResolver([
      { stableId: 'unplaced', projectOffset: null },
      { stableId: 'placed', projectOffset: [FAR, 0, 0] },
    ]);
    expect(unresolvedMetricKeys(spanning, UP, 1, 1, r(spanning))).toEqual(['length_m']);
  });
});

describe('every surface withholds the same figure', () => {
  const collapsed = m('distance', [[FAR, 0, 0], [FAR, 0, 0]], { name: 'Tie' } as Partial<Measurement>);
  const steady = m('distance', [[FAR, 0, 0], [FAR, 3, 0]], { id: 'steady', name: 'Run' } as Partial<Measurement>);
  const stepsOf = (x: Measurement) => positionSteps(x.points, null);

  it('the note names the key, the step and the remedy', () => {
    expect(unresolvedNote(collapsed, UP, 1, 1, stepsOf(collapsed))).toMatch(/^length_m not resolved: positions on this scan are held about 15\.63 mm apart/);
    expect(unresolvedNote(steady, UP, 1, 1, stepsOf(steady))).toBeUndefined();
  });

  it('GeoJSON: the key is null and the feature says why', () => {
    const ctx: MeasurementExportContext = {
      toOutput: (p) => [p[0], p[1], p[2]], lonLat: { ...IDENTITY_LONLAT, map: (p) => [p[0] / 1e4, p[1] / 1e4, p[2]] },
      up: UP, unitToMetres: 1, crsName: 'EPSG:32612', positionSteps: stepsOf,
    };
    const fc = JSON.parse(measurementsToGeoJSON([collapsed], ctx));
    const props = fc.features[0].properties;
    expect(props.length_m).toBeNull();
    expect(props.not_resolved).toMatch(/held about 15\.63 mm apart/);
  });

  it('report findings: an explicit null with the reason, not another figure', () => {
    const f = measurementsToFindings([collapsed, steady], UP, 1, 1, { positionSteps: stepsOf });
    expect(f[0].value).toBeNull();
    expect(f[0].caveats?.[0]).toMatch(/not resolved/);
    expect(f[1].value).toBeCloseTo(3, 2);
  });

  it('PDF rows: the headline is the reason', () => {
    const rows = buildMeasurementRows([collapsed, steady], 'metric', 1, UP, 1, true, false, false, false, stepsOf);
    expect(rows[0].value).toMatch(/^length_m not resolved/);
    expect(rows[1].value).toMatch(/3(\.0+)? m/);
  });

  it('chains: a total with an unresolved member is refused, not summed', () => {
    const r = aggregate([collapsed, steady], 'sum', 'length', UP, 1, 1, { positionSteps: stepsOf });
    expect(Number.isNaN(r.value)).toBe(true);
    expect(r.refusal).toBe(CHAIN_UNRESOLVED);
    expect(aggregate([steady], 'sum', 'length', UP, 1, 1, { positionSteps: stepsOf }).value).toBeCloseTo(3, 2);
  });
});
