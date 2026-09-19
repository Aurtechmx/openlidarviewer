import { describe, it, expect } from 'vitest';
import {
  nodeCoverageScale,
  coarseLodScale,
  MAX_COVERAGE_SCALE,
  MAX_LOD_SCALE,
} from '../src/render/streamingLodSize';
import type { PointSizeMode } from '../src/render/pointStyle';

const MODES: PointSizeMode[] = ['adaptive', 'fixed', 'density'];

describe('node coverage scale', () => {
  // A streamed node has no points to count, so it sizes from the spacing its
  // source recorded. Coarsest gets the largest point.
  it('grows with the spacing a node was recorded at', () => {
    expect(nodeCoverageScale(1, 1, 'density')).toBeCloseTo(MAX_COVERAGE_SCALE, 12);
    expect(nodeCoverageScale(0.5, 1, 'density')).toBeCloseTo(1 + (MAX_COVERAGE_SCALE - 1) / 2, 12);
    expect(nodeCoverageScale(0.001, 1, 'density')).toBeGreaterThan(1);
  });

  it('is monotonic in spacing', () => {
    let prev = 0;
    for (const r of [0.05, 0.1, 0.25, 0.5, 0.75, 1]) {
      const s = nodeCoverageScale(r, 1, 'density');
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  // Only the mode the user asked for changes. Nothing rendering today moves.
  it('is identity outside density mode', () => {
    for (const mode of ['adaptive', 'fixed'] as PointSizeMode[]) {
      for (const r of [0, 0.5, 1]) expect(nodeCoverageScale(r, 1, mode)).toBe(1);
    }
  });

  // relativeNodeResolution answers 0 rather than guessing, and no sizing beats
  // sizing from a number that was not there.
  it.each([
    [0, 1],
    [-1, 1],
    [1, 0],
    [Number.NaN, 1],
    [1, Number.NaN],
    [Number.POSITIVE_INFINITY, 1],
  ])('takes identity for unusable resolutions (%p, %p)', (node, root) => {
    expect(nodeCoverageScale(node, root, 'density')).toBe(1);
  });

  it('stays within its bound however large the ratio', () => {
    for (const r of [1, 5, 1000]) {
      const s = nodeCoverageScale(r, 1, 'density');
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(MAX_COVERAGE_SCALE);
    }
  });

  it.each(MODES)('never shrinks a point in %s mode', (mode) => {
    for (const r of [0, 0.3, 1]) expect(nodeCoverageScale(r, 1, mode)).toBeGreaterThanOrEqual(1);
  });
});

describe('coverage sizing against refinement compensation', () => {
  // The distinction this exists for: compensation is built to vanish once a
  // view settles, so without a persistent term a settled frontier renders its
  // coarse nodes at the same size as its fine ones.
  it('survives the settle that compensation fades out of', () => {
    expect(coarseLodScale(1, 'full-refine', 'density')).toBe(1);
    expect(nodeCoverageScale(1, 1, 'density')).toBeGreaterThan(1);
  });

  it('is present while moving too, alongside compensation', () => {
    expect(coarseLodScale(1, 'moving', 'density')).toBeCloseTo(MAX_LOD_SCALE, 12);
    expect(nodeCoverageScale(1, 1, 'density')).toBeCloseTo(MAX_COVERAGE_SCALE, 12);
  });

  // The two bounds start equal and are not the same number. Nothing at runtime
  // can tell an alias from a copy of 1.6, so this pins the value each is
  // expected to hold rather than pretending to check their independence.
  it('holds its own bound', () => {
    expect(MAX_COVERAGE_SCALE).toBe(1.6);
    expect(nodeCoverageScale(1, 1, 'density')).toBeCloseTo(MAX_COVERAGE_SCALE, 12);
  });
});
