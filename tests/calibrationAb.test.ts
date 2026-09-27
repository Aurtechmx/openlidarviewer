import { describe, expect, it } from 'vitest';
import { CRITERIA_CAL_V1, judgeTrajectory, type CalSample } from '../scripts/calibration-ab.mjs';

const row = (pair: number, p95: number, over: Partial<CalSample> = {}): CalSample => ({
  pair, frameP95Ms: p95, over50: 1, qualityTransitions: 2, fullQualityMs: 300, firstRenderMs: 1000,
  presentation: { backingRatio: 1, governor: { renderScale: 1, pointBudgetFraction: 1, reducedMeshes: 0 } }, ...over,
});

describe('calibration A/B criteria', () => {
  it('holds the pre-registered constants', () => {
    expect(CRITERIA_CAL_V1).toMatchObject({ p95MaxRatio: 1.05, firstRenderMaxExtraMs: 100, qualityTransitionsMaxExtraOverFixed: 2, fullQualityMaxExtraMs: 500 });
  });

  it('passes an equal pair and fails each clause on its own', () => {
    const off = [0, 1, 2].map((p) => row(p, 40));
    expect(judgeTrajectory(off, [0, 1, 2].map((p) => row(p, 41)), true).failed).toEqual([]);
    expect(judgeTrajectory(off, [0, 1, 2].map((p) => row(p, 43)), true).failed).toEqual(['p95NotWorse']);
    expect(judgeTrajectory(off, [0, 1, 2].map((p) => row(p, 40, { firstRenderMs: 1200 })), true).failed).toEqual(['firstRender']);
    expect(judgeTrajectory(off, [0, 1, 2].map((p) => row(p, 40, { qualityTransitions: 5 })), true).failed).toEqual(['qualityTransitions']);
    expect(judgeTrajectory(off, [0, 1, 2].map((p) => row(p, 40, { fullQualityMs: null })), true).failed).toEqual(['fullQualityFromLastInput']);
    expect(judgeTrajectory(off, off, false).failed).toEqual(['digestsIdentical']);
  });
});
