/** The pre-registered v3 governor A/B criteria and the paired bootstrap. */
import { describe, expect, it } from 'vitest';
import { CRITERIA_V3, V3_PAIRS, judgeTrajectoryV3, mulberry32, pairedBootstrapCI, plan, type V3Sample } from '../scripts/governor-ab.mjs';

const pres = (g: Record<string, number> | null) => ({ backingRatio: 2, governor: g });
const FULL = { renderScale: 1, pointBudgetFraction: 1, reducedMeshes: 0 };

function arm(n: number, f: (k: number) => Partial<V3Sample>, g: Record<string, number> | null): V3Sample[] {
  return Array.from({ length: n }, (_, k) => ({
    pair: k, frameP95Ms: 30, over50: 3, qualityTransitions: 4, fullQualityMs: 400, presentation: pres(g), ...f(k),
  }));
}

const passingOff = () => arm(7, () => ({}), null);
const passingOn = () => arm(7, () => ({ frameP95Ms: 25, over50: 2, qualityTransitions: 6, fullQualityMs: 900 }), FULL);

describe('CRITERIA_V3', () => {
  it('is the pre-registered set', () => {
    expect(CRITERIA_V3).toMatchObject({
      p95MinImprovement: 0.1, over50MayIncrease: false, qualityTransitionsMaxExtraOverOff: 2,
      fullQualityMaxExtraMs: 500, bootstrapResamples: 2000, ciLevel: 0.95,
    });
    expect(Object.isFrozen(CRITERIA_V3)).toBe(true);
    expect(V3_PAIRS).toBeGreaterThanOrEqual(7);
    expect(plan(V3_PAIRS).map((s) => s.cond).slice(0, 4)).toEqual(['off', 'on', 'off', 'on']);
  });

  it('passes at the boundaries of every clause', () => {
    const r = judgeTrajectoryV3(passingOff(), passingOn(), true);
    expect(r.failed).toEqual([]);
    expect(r.criteria.qualityTransitions.limit).toBe(6);
    expect(r.criteria.fullQualityFromLastInput.extraMs).toBe(500);
  });

  it('fails each clause on its own', () => {
    const on = (p: Partial<V3Sample>) => passingOn().map((r) => ({ ...r, ...p }));
    expect(judgeTrajectoryV3(passingOff(), on({ frameP95Ms: 27.1 }), true).failed).toEqual(['p95Improvement']);
    expect(judgeTrajectoryV3(passingOff(), on({ over50: 4 }), true).failed).toEqual(['over50NoIncrease']);
    expect(judgeTrajectoryV3(passingOff(), on({ qualityTransitions: 7 }), true).failed).toEqual(['qualityTransitions']);
    expect(judgeTrajectoryV3(passingOff(), on({ fullQualityMs: 901 }), true).failed).toEqual(['fullQualityFromLastInput']);
    expect(judgeTrajectoryV3(passingOff(), on({ presentation: pres({ ...FULL, renderScale: 0.6 }) }), true).failed).toEqual(['settledRestored']);
    expect(judgeTrajectoryV3(passingOff(), passingOn(), false).failed).toEqual(['digestsIdentical']);
  });

  it('measures clause 4 from the last input in both arms and counts never-reached as infinite', () => {
    const on = passingOn().map((r, k) => ({ ...r, fullQualityMs: k < 4 ? null : 400 }));
    const c = judgeTrajectoryV3(passingOff(), on, true).criteria.fullQualityFromLastInput;
    expect(c.pass).toBe(false);
    expect(c.on.median).toBeNull();
  });
});

describe('pairedBootstrapCI', () => {
  it('is deterministic for a fixed seed and brackets the point estimate', () => {
    const off = arm(7, (k) => ({ frameP95Ms: 30 + k }), null);
    const on = arm(7, (k) => ({ frameP95Ms: 24 + k * 0.5 }), FULL);
    const d = (a: number, b: number) => (a - b) / a;
    const a = pairedBootstrapCI(off, on, 'frameP95Ms', d);
    const b = pairedBootstrapCI(off, on, 'frameP95Ms', d);
    expect(a).toEqual(b);
    expect(a.resamples).toBe(2000);
    expect(a.pairs).toBe(7);
    const point = d(33, 25.5);
    expect(a.lo!).toBeLessThanOrEqual(point);
    expect(a.hi!).toBeGreaterThanOrEqual(point);
    expect(a.lo!).toBeGreaterThan(0);
  });

  it('collapses to the constant delta when every pair has the same difference', () => {
    const off = arm(7, () => ({ fullQualityMs: 400 }), null);
    const on = arm(7, () => ({ fullQualityMs: 650 }), FULL);
    expect(pairedBootstrapCI(off, on, 'fullQualityMs', (a, b) => b - a)).toMatchObject({ lo: 250, hi: 250 });
  });

  it('matches off and on by pair', () => {
    const off = arm(3, (k) => ({ fullQualityMs: 100 * k }), null);
    const on = arm(3, (k) => ({ fullQualityMs: 100 * k + 50 }), FULL).reverse();
    expect(pairedBootstrapCI(off, on, 'fullQualityMs', (a, b) => b - a, { resamples: 500 })).toMatchObject({ lo: 50, hi: 50 });
  });

  it('mulberry32 is seeded and in [0, 1)', () => {
    const r1 = mulberry32(1);
    const r2 = mulberry32(1);
    const xs = Array.from({ length: 100 }, () => r1());
    expect(xs).toEqual(Array.from({ length: 100 }, () => r2()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
