/**
 * samplingPlan.test.ts
 *
 * Pins the breadth-first full-cloud sampling plan: budget truncation, the
 * always-decode-something floor, depth capping, exhaustive detection, and the
 * honest coverage fraction.
 */

import { describe, it, expect } from 'vitest';
import { buildSamplingPlan, type SampleNode } from '../src/render/streaming/samplingPlan';

function node(id: string, depth: number, pointCount: number, byteSize = 1000): SampleNode {
  return { id, depth, pointCount, byteSize };
}

// A tiny 3-level tree: root, two depth-1 nodes, three depth-2 nodes.
const TREE: SampleNode[] = [
  node('2-0-0-0', 2, 100),
  node('0-0-0-0', 0, 1000),
  node('1-0-0-0', 1, 400),
  node('2-1-0-0', 2, 120),
  node('1-1-0-0', 1, 500),
  node('2-2-0-0', 2, 80),
];
const TOTAL = 1000 + 400 + 500 + 100 + 120 + 80; // 2200

describe('buildSamplingPlan — ordering', () => {
  it('decodes breadth-first: shallow depths first', () => {
    const plan = buildSamplingPlan(TREE, { maxPoints: Infinity });
    expect(plan.nodeIds[0]).toBe('0-0-0-0'); // root first
    // depth-1 nodes before any depth-2 node
    expect(plan.nodeIds.indexOf('1-1-0-0')).toBeLessThan(plan.nodeIds.indexOf('2-0-0-0'));
  });

  it('breaks depth ties by larger node then id (deterministic)', () => {
    const plan = buildSamplingPlan(TREE, { maxPoints: Infinity });
    // at depth 1, 500-pt node precedes 400-pt node
    expect(plan.nodeIds.indexOf('1-1-0-0')).toBeLessThan(plan.nodeIds.indexOf('1-0-0-0'));
  });
});

describe('buildSamplingPlan — budgets', () => {
  it('an ample budget is exhaustive with full coverage', () => {
    const plan = buildSamplingPlan(TREE, { maxPoints: 1_000_000 });
    expect(plan.exhaustive).toBe(true);
    expect(plan.sampledPoints).toBe(TOTAL);
    expect(plan.coverageFraction).toBe(1);
    expect(plan.maxDepthReached).toBe(2);
  });

  it('a tight point budget truncates and is NOT exhaustive', () => {
    const plan = buildSamplingPlan(TREE, { maxPoints: 1200 });
    expect(plan.exhaustive).toBe(false);
    // root (1000) then one depth-1 node pushes over 1200 and stops next iter.
    expect(plan.sampledPoints).toBeGreaterThanOrEqual(1200);
    expect(plan.coverageFraction).toBeLessThan(1);
    expect(plan.coverageFraction).toBeGreaterThan(0);
  });

  it('always decodes at least one node when the budget is tiny', () => {
    const plan = buildSamplingPlan(TREE, { maxPoints: 1 });
    expect(plan.nodeIds).toEqual(['0-0-0-0']);
    expect(plan.sampledPoints).toBe(1000);
  });

  it('honours a byte budget independently of points', () => {
    const plan = buildSamplingPlan(TREE, { maxPoints: Infinity, maxBytes: 2500 });
    // 1000-byte nodes: takes root, then stops once cumulative ≥ 2500.
    expect(plan.sampledBytes).toBeGreaterThanOrEqual(2500);
    expect(plan.exhaustive).toBe(false);
  });
});

describe('buildSamplingPlan — depth cap & edges', () => {
  it('maxDepth excludes deeper nodes (not exhaustive of the full tree)', () => {
    const plan = buildSamplingPlan(TREE, { maxPoints: Infinity, maxDepth: 1 });
    expect(plan.maxDepthReached).toBe(1);
    expect(plan.nodeIds.some((id) => id.startsWith('2-'))).toBe(false);
    expect(plan.exhaustive).toBe(false); // depth-2 nodes were dropped
  });

  it('an empty tree yields an empty, zero-coverage plan', () => {
    const plan = buildSamplingPlan([]);
    expect(plan.nodeIds).toEqual([]);
    expect(plan.totalPoints).toBe(0);
    expect(plan.coverageFraction).toBe(0);
    expect(plan.maxDepthReached).toBe(-1);
    expect(plan.exhaustive).toBe(true); // 0 of 0 selected
  });
});
