/**
 * compareLoadedLayers.test.ts — the extracted two-epoch compare flow's guard
 * behaviour at its injected seams. The heavy change-detection compute is covered
 * by compareDtms / alignEpochs tests; this pins the shell wiring: the flow runs
 * only for exactly two resolvable clouds, and otherwise is a clean no-op.
 */

import { describe, it, expect } from 'vitest';
import { compareLoadedLayers, type CompareLayersDeps } from '../src/app/compareLoadedLayers';
import type { PointCloud } from '../src/model/PointCloud';

/** A minimal cloud stand-in; the guard paths never read its geometry. */
const fakeCloud = (name: string): PointCloud => ({ name } as unknown as PointCloud);

function deps(clouds: Record<string, PointCloud | null>, ids: string[]): CompareLayersDeps & {
  compareResult: string[][]; diffAvailable: boolean[]; lastDiffs: unknown[];
} {
  const compareResult: string[][] = [];
  const diffAvailable: boolean[] = [];
  const lastDiffs: unknown[] = [];
  return {
    cloudIds: () => ids,
    getCloud: (id) => clouds[id] ?? null,
    setCompareResult: (l) => compareResult.push(l),
    setDifferenceAvailable: (v) => diffAvailable.push(v),
    setLastDifference: (d) => lastDiffs.push(d),
    compareResult, diffAvailable, lastDiffs,
  };
}

describe('compareLoadedLayers guard behaviour', () => {
  it('is a no-op unless exactly two clouds are loaded', () => {
    for (const ids of [[], ['a'], ['a', 'b', 'c']]) {
      const d = deps({ a: fakeCloud('a'), b: fakeCloud('b'), c: fakeCloud('c') }, ids);
      compareLoadedLayers(d);
      expect(d.compareResult).toHaveLength(0);
      expect(d.diffAvailable).toHaveLength(0);
      expect(d.lastDiffs).toHaveLength(0);
    }
  });

  it('is a no-op when a referenced cloud cannot be resolved', () => {
    const d = deps({ a: fakeCloud('a'), b: null }, ['a', 'b']);
    compareLoadedLayers(d);
    expect(d.compareResult).toHaveLength(0); // returns before the "Comparing…" line
  });

  it('with two resolvable clouds, immediately shows working state and clears any prior difference', () => {
    const d = deps({ a: fakeCloud('a.laz'), b: fakeCloud('b.laz') }, ['a', 'b']);
    compareLoadedLayers(d);
    // These three run synchronously, before the on-demand compute is scheduled.
    expect(d.compareResult[0][0]).toMatch(/Comparing elevations/);
    expect(d.diffAvailable).toEqual([false]);
    expect(d.lastDiffs).toEqual([null]);
  });
});
