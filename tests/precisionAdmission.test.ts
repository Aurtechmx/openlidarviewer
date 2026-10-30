/**
 * precisionAdmission.test.ts: a figure is admitted on the error its held
 * positions can carry, not on the size of the rounded result.
 *
 * Positions are held as Float32 around a layer origin. A separation rounded up
 * to a whole step is as wrong as one rounded down to zero, so every rounding
 * phase on a coarse axis is withheld, the same figure on a fine axis is kept,
 * and the decision reaches every surface that prints the figure: the panel
 * headline and breakdown, the profile chart, chains, exports and the report.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { positionSteps, unresolvedMetricKeys } from '../src/render/measure/geometry';
import { measurementMetrics } from '../src/export/measurementExport';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { aggregate, CHAIN_UNRESOLVED } from '../src/render/measure/measurementChains';
import { MeasureController } from '../src/render/measure/MeasureController';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { installFakeDom } from './support/measurePanelDom';

/** A distance along X held below the step withholds its length, run and grade together. */
const DISTANCE_HELD_KEYS = ['length_m', 'horizontal_m', 'run_m', 'grade_pct'];

beforeAll(() => installFakeDom({ ns: true }));

const UP: Vec3 = [0, 0, 1];
const m = (kind: Measurement['kind'], points: Vec3[], id: string = kind): Measurement =>
  ({ id, kind, name: id, closed: kind === 'area', points }) as Measurement;
/** A point as a layer buffer holds it: Float32 about the layer origin. */
const held = (p: Vec3): Vec3 => [Math.fround(p[0]), Math.fround(p[1]), Math.fround(p[2])];
const stepsOf = (x: Measurement) => positionSteps(x.points, null);

describe('every rounding phase on a coarse axis is withheld', () => {
  const separations = [0.005, 0.0078, 0.01, 0.015625, 0.02, 0.05, 3];
  const origins = [200_000, 200_000.005, 200_000.0101, -200_000.003, 524_288.001];

  it('withholds a held distance along X, whatever it rounded to', () => {
    for (const x0 of origins) {
      for (const d of separations) {
        const dist = m('distance', [held([x0, 0, 0]), held([x0 + d, 0, 0])]);
        expect(unresolvedMetricKeys(dist, UP, 1, 1, stepsOf(dist)), `x0=${x0} d=${d}`).toEqual(DISTANCE_HELD_KEYS);
        expect(measurementMetrics(dist, UP, 1, 1, 3, stepsOf(dist)).length_m).toBeUndefined();
      }
    }
  });

  it('keeps the same separations near the origin, to the millimetre', () => {
    for (const d of separations) {
      const dist = m('distance', [held([1000, 0, 0]), held([1000 + d, 0, 0])]);
      expect(unresolvedMetricKeys(dist, UP, 1, 1, stepsOf(dist))).toEqual([]);
      expect(measurementMetrics(dist, UP, 1, 1, 6, stepsOf(dist)).length_m).toBeCloseTo(d, 3);
    }
  });

  it('keeps a run along a fine axis on a scan wide only in X, but not one shorter than the X step', () => {
    const run = m('distance', [held([200_000, 0, 0]), held([200_000, 3, 0])]);
    expect(measurementMetrics(run, UP, 1, 1, 6, stepsOf(run)).length_m).toBeCloseTo(3, 4);
    // The held X values agree, but the source X values may differ by up to a step.
    const short = m('distance', [held([200_000, 0, 0]), held([200_000, 0.005, 0])]);
    expect(measurementMetrics(short, UP, 1, 1, 6, stepsOf(short)).length_m).toBeUndefined();
  });

  it('applies the unit before the budget', () => {
    // 200 km in US survey feet is held at a coarser step in metres.
    const ft = 1200 / 3937;
    const dist = m('distance', [held([200_000 / ft, 0, 0]), held([200_000 / ft + 3, 0, 0])]);
    expect(unresolvedMetricKeys(dist, UP, ft, ft, stepsOf(dist))).toEqual(DISTANCE_HELD_KEYS);
  });
});

describe('the panel prints no number it withholds', () => {
  const controller = (ms: Measurement[]) => {
    const c = new MeasureController({ onExit: () => {}, getPickRay: () => null, getPointAt: () => null } as never);
    c.setContext({ worldUp: UP, origin: null } as never);
    c.setPositionStepResolver(stepsOf);
    c.loadMeasurements(ms);
    return c;
  };

  it('a withheld distance has a reason and no breakdown', () => {
    const [s] = controller([m('distance', [held([200_000, 0, 0]), held([200_000.005, 0, 0])])]).getSummaries();
    expect(s!.value).toMatch(/^not resolved/);
    expect(s!.lineMetrics).toBeUndefined();
  });

  it('a resolved distance keeps its breakdown', () => {
    const [s] = controller([m('distance', [held([1000, 0, 0]), held([1003, 0, 4])])]).getSummaries();
    expect(s!.value).not.toMatch(/not resolved/);
    expect(s!.lineMetrics?.length3dM).toBeCloseTo(5, 3);
  });

  it('a profile whose height change is withheld prints no height change, grade or chart', () => {
    const p = m('profile', [held([0, 0, 200_000]), held([10, 0, 200_000])]);
    p.profileChart = [{ distance: 0, height: 200_000 }, { distance: 10, height: 200_000 }] as never;
    const [s] = controller([p]).getSummaries();
    expect(s!.value).toMatch(/^not resolved/);
    expect(s!.profileChart).toBeUndefined();
  });
});

describe('chains admit only what every member can give', () => {
  const coarseBox = m('box', [held([200_000, 0, 0]), held([200_000, 1, 1])], 'coarse');
  const fineBox = m('box', [held([0, 0, 0]), held([2, 3, 4])], 'fine');
  const flatBox = m('box', [held([0, 0, 0]), held([2, 3, 0])], 'flat');

  it('refuses box area and volume when a box extent is withheld', () => {
    for (const dim of ['area', 'volume-fill'] as const) {
      const r = aggregate([coarseBox, fineBox], 'sum', dim, UP, 1, 1, { positionSteps: stepsOf });
      expect(Number.isNaN(r.value), dim).toBe(true);
      expect(r.refusal).toBe(CHAIN_UNRESOLVED);
    }
  });

  it('sums boxes that are held finely, a genuine zero volume included', () => {
    const area = aggregate([fineBox, flatBox], 'sum', 'area', UP, 1, 1, { positionSteps: stepsOf });
    expect(area.value).toBeCloseTo(12, 6);
    const vol = aggregate([fineBox, flatBox], 'sum', 'volume-fill', UP, 1, 1, { positionSteps: stepsOf });
    expect(vol.value).toBeCloseTo(24, 6);
    expect(vol.contributingCount).toBe(2);
  });
});

describe('the report detail follows the same decision', () => {
  it('a profile at a coarse height prints no height change, grade, slope summary or chart', () => {
    const p = m('profile', [held([0, 0, 200_000]), held([10, 0, 200_000])]);
    p.profileChart = [{ distance: 0, height: 200_000 }, { distance: 5, height: 200_000 }, { distance: 10, height: 200_000 }] as never;
    const [row] = buildMeasurementRows([p], 'metric', 1, UP, 1, true, false, false, false, stepsOf);
    const x = row!.profileExtras!;
    expect(x.summary).toMatch(/Horizontal 10(\.0+)? m/);
    expect(x.summary).toMatch(/Δh — · — grade/);
    expect(x.slopeSummary).toMatch(/^Slope summary withheld: not resolved/);
    expect(x.chart).toBeUndefined();
  });

  it('the same profile near the origin keeps every figure', () => {
    const p = m('profile', [held([0, 0, 100]), held([10, 0, 101])]);
    const [row] = buildMeasurementRows([p], 'metric', 1, UP, 1, true, false, false, false, stepsOf);
    expect(row!.profileExtras!.summary).toMatch(/Δh 1(\.0+)? m · 10\.00% grade/);
  });
});
