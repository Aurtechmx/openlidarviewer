/**
 * fullCloudGrade.test.ts — the honesty + density back-scale derived from a
 * full-cloud sampling plan. Pins: exhaustive → exact label + scale 1; sampled →
 * coverage % + back-scale ≥ 1; degenerate plans never produce NaN/Infinity.
 */

import { describe, it, expect } from 'vitest';
import { buildSamplingPlan, type SampleNode } from '../src/render/streaming/samplingPlan';
import { fullCloudGradeCoverage } from '../src/render/streaming/fullCloudGrade';

function nodes(spec: Array<[depth: number, points: number]>): SampleNode[] {
  return spec.map(([depth, pointCount], i) => ({ id: `${depth}-${i}-0-0`, depth, pointCount, byteSize: pointCount * 4 }));
}

describe('fullCloudGradeCoverage', () => {
  it('labels an exhaustive plan as exact, with no back-scale', () => {
    const plan = buildSamplingPlan(nodes([[0, 500_000], [1, 1_300_000]]), { maxPoints: 10_000_000 });
    expect(plan.exhaustive).toBe(true);
    const cov = fullCloudGradeCoverage(plan);
    expect(cov.scope).toBe('exhaustive');
    expect(cov.coveragePercent).toBe(100);
    expect(cov.samplePointScale).toBe(1);
    expect(cov.label).toBe('all 1.8M points (exact)');
    expect(cov.note).toBe('');
  });

  it('labels a budget-truncated plan as sampled, with coverage % and a back-scale', () => {
    // 2M point budget over an 18M cloud → ~11% coverage, ~9× back-scale.
    const plan = buildSamplingPlan(
      nodes([[0, 500_000], [1, 1_500_000], [2, 8_000_000], [3, 8_000_000]]),
      { maxPoints: 2_000_000 },
    );
    expect(plan.exhaustive).toBe(false);
    const cov = fullCloudGradeCoverage(plan);
    expect(cov.scope).toBe('sampled');
    expect(cov.totalPoints).toBe(18_000_000);
    expect(cov.sampledPoints).toBe(2_000_000); // shallow nodes 500k + 1.5M
    expect(cov.coveragePercent).toBe(11);
    expect(cov.samplePointScale).toBeCloseTo(9, 5);
    expect(cov.label).toBe('2M of 18M points (11%, sampled)');
    expect(cov.note).toMatch(/representative octree sample/i);
  });

  it('collapses a tiny-but-nonzero coverage to "<1%"', () => {
    const plan = buildSamplingPlan(
      nodes([[0, 1_000], [1, 50_000_000]]),
      { maxPoints: 1 }, // budget forces a single shallow node
    );
    const cov = fullCloudGradeCoverage(plan);
    expect(cov.scope).toBe('sampled');
    expect(cov.coveragePercent).toBe(0);
    expect(cov.label).toMatch(/\(<1%, sampled\)/);
    // Back-scale is large but finite.
    expect(Number.isFinite(cov.samplePointScale)).toBe(true);
    expect(cov.samplePointScale).toBeGreaterThan(1000);
  });

  it('never produces NaN/Infinity for an empty plan', () => {
    const plan = buildSamplingPlan([], {});
    const cov = fullCloudGradeCoverage(plan);
    expect(cov.samplePointScale).toBe(1);
    expect(cov.coveragePercent).toBe(0);
    expect(cov.label).toBe('no points available to grade');
    expect(Number.isFinite(cov.samplePointScale)).toBe(true);
  });

  it('back-scale times sampled density recovers the whole-cloud magnitude', () => {
    const plan = buildSamplingPlan(
      nodes([[0, 1_000_000], [1, 3_000_000]]),
      { maxPoints: 1_000_000 }, // decode only the 1M root
    );
    const cov = fullCloudGradeCoverage(plan);
    // A sampled density of D over the sample scales to D*scale for the cloud;
    // sampledPoints * scale ≈ totalPoints.
    expect(cov.sampledPoints * cov.samplePointScale).toBeCloseTo(cov.totalPoints, 5);
  });
});
