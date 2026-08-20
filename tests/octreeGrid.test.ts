/**
 * octreeGrid.test.ts — the fixed-depth octree geometry the out-of-core indexer
 * buckets points into.
 *
 * The grid is pure geometry: a cubic root cube that contains the data, a depth
 * chosen from the point count, and a mapping from a point to the octant-path key
 * of the leaf that holds it. The two properties every later stage depends on are
 * pinned here — a point always lands inside the cube of the key it is given, and
 * two points in the same leaf get the same key — so the indexer can spill by key
 * and trust that the geometry is sound.
 */
import { describe, it, expect } from 'vitest';
import { octreeGridFor, type Cube } from '../src/io/heavy/octreeGrid';

/** Deterministic LCG so the random-point sweep is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
}

function contains(cube: Cube, p: readonly [number, number, number]): boolean {
  for (let a = 0; a < 3; a++) {
    if (p[a] < cube.min[a] || p[a] > cube.min[a] + cube.size) return false;
  }
  return true;
}

describe('octreeGrid', () => {
  const min: [number, number, number] = [500000, 4100000, 190];
  const max: [number, number, number] = [500800, 4100600, 260];

  it('roots a cubic cube that contains the data bounds', () => {
    const grid = octreeGridFor(min, max, 1_000_000, 100_000);
    // Cubic: one size for all three axes, at least the widest extent.
    expect(grid.root.size).toBeGreaterThanOrEqual(max[0] - min[0]);
    expect(grid.root.size).toBeGreaterThanOrEqual(max[1] - min[1]);
    expect(grid.root.size).toBeGreaterThanOrEqual(max[2] - min[2]);
    expect(contains(grid.root, min)).toBe(true);
    expect(contains(grid.root, max)).toBe(true);
  });

  it('picks a depth so a leaf holds roughly the target point count', () => {
    // 1e6 points / 1e5 per leaf = 10 leaves needed → depth 1 gives 8, depth 2
    // gives 64, so depth 2 is the first that clears the target.
    expect(octreeGridFor(min, max, 1_000_000, 100_000).depth).toBe(2);
    // At or below the target, no split is needed.
    expect(octreeGridFor(min, max, 50_000, 100_000).depth).toBe(0);
    // The cap holds however large the count.
    expect(octreeGridFor(min, max, 1e12, 1000, 10).depth).toBe(10);
  });

  it('gives every point a key whose cube contains it', () => {
    const grid = octreeGridFor(min, max, 5_000_000, 100_000);
    const rnd = lcg(42);
    for (let i = 0; i < 20_000; i++) {
      const p: [number, number, number] = [
        min[0] + rnd() * (max[0] - min[0]),
        min[1] + rnd() * (max[1] - min[1]),
        min[2] + rnd() * (max[2] - min[2]),
      ];
      const key = grid.leafKeyFor(p[0], p[1], p[2]);
      expect(key).toHaveLength(grid.depth);
      expect(contains(grid.cubeFor(key), p)).toBe(true);
    }
  });

  it('maps the extreme corners to distinct in-range leaves', () => {
    const grid = octreeGridFor(min, max, 5_000_000, 100_000);
    const lo = grid.leafKeyFor(min[0], min[1], min[2]);
    const hi = grid.leafKeyFor(max[0], max[1], max[2]);
    expect(lo).not.toBe(hi);
    // Every octant digit is 0..7 and the path is exactly `depth` long.
    for (const key of [lo, hi]) {
      expect(key).toMatch(/^[0-7]*$/);
      expect(key).toHaveLength(grid.depth);
    }
    expect(contains(grid.cubeFor(lo), min)).toBe(true);
    expect(contains(grid.cubeFor(hi), max)).toBe(true);
  });

  it('nests child cubes inside their parent, each an eighth of the volume', () => {
    const grid = octreeGridFor(min, max, 5_000_000, 100_000);
    const parent = grid.cubeFor('3');
    const child = grid.cubeFor('35');
    expect(child.size).toBeCloseTo(parent.size / 2, 6);
    for (let a = 0; a < 3; a++) {
      expect(child.min[a]).toBeGreaterThanOrEqual(parent.min[a]);
      expect(child.min[a] + child.size).toBeLessThanOrEqual(parent.min[a] + parent.size + 1e-6);
    }
    // The empty key is the root itself.
    expect(grid.cubeFor('')).toEqual(grid.root);
  });
});
