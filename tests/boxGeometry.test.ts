/**
 * tests/boxGeometry.test.ts
 *
 * Coverage for the v0.3.7 Box measurement kind's pure geometry — the
 * 2-point-diagonal normalisation, the scalar metrics, the corner / edge
 * tables, and the point-in-box test that the inspector clipping toggle
 * (and the upcoming volume measurement) build on.
 */

import { describe, it, expect } from 'vitest';
import {
  boxFromCorners,
  boxMetrics,
  boxCorners,
  BOX_EDGES,
  pointInBox,
  countPointsInBox,
} from '../src/render/measure/geometry';

const Z = (n: number): [number, number, number] => [0, 0, n];

describe('boxFromCorners — normalises corner order per axis', () => {
  it('places the larger value in `max` for every axis', () => {
    const b = boxFromCorners([3, -2, 9], [-1, 4, 1]);
    expect(b.min).toEqual([-1, -2, 1]);
    expect(b.max).toEqual([3, 4, 9]);
  });

  it('produces the same box regardless of diagonal direction', () => {
    const a = boxFromCorners([0, 0, 0], [5, 5, 5]);
    const b = boxFromCorners([5, 5, 5], [0, 0, 0]);
    expect(a.min).toEqual(b.min);
    expect(a.max).toEqual(b.max);
  });

  it('collapses degenerate axes when corners share a coordinate', () => {
    const flat = boxFromCorners([0, 0, 0], [3, 4, 0]);
    expect(flat.min).toEqual([0, 0, 0]);
    expect(flat.max).toEqual([3, 4, 0]);
  });
});

describe('boxMetrics — width / depth / height / volume / area', () => {
  it('computes per-axis spans and their product as volume', () => {
    const m = boxMetrics(boxFromCorners([0, 0, 0], [2, 3, 4]));
    expect(m.width).toBe(2);
    expect(m.depth).toBe(3);
    expect(m.height).toBe(4);
    expect(m.volume).toBe(24);
    expect(m.surfaceArea).toBe(2 * (2 * 3 + 3 * 4 + 2 * 4));
  });

  it('returns zero volume when any axis collapses', () => {
    const m = boxMetrics(boxFromCorners([0, 0, 0], [2, 3, 0]));
    expect(m.height).toBe(0);
    expect(m.volume).toBe(0);
  });

  it('reports a unit cube correctly', () => {
    const m = boxMetrics(boxFromCorners([0, 0, 0], [1, 1, 1]));
    expect(m.volume).toBe(1);
    expect(m.surfaceArea).toBe(6);
  });
});

describe('boxCorners + BOX_EDGES — wireframe overlay tables', () => {
  it('returns exactly 8 corners in the documented order', () => {
    const corners = boxCorners(boxFromCorners([0, 0, 0], [1, 1, 1]));
    expect(corners).toHaveLength(8);
    // bottom rim (z = 0)
    expect(corners[0]).toEqual([0, 0, 0]);
    expect(corners[1]).toEqual([1, 0, 0]);
    expect(corners[2]).toEqual([1, 1, 0]);
    expect(corners[3]).toEqual([0, 1, 0]);
    // top rim (z = 1)
    expect(corners[4]).toEqual([0, 0, 1]);
    expect(corners[5]).toEqual([1, 0, 1]);
    expect(corners[6]).toEqual([1, 1, 1]);
    expect(corners[7]).toEqual([0, 1, 1]);
  });

  it('declares exactly 12 edges, none repeated', () => {
    expect(BOX_EDGES).toHaveLength(12);
    // Each edge canonicalised (lo, hi) — all must be distinct.
    const seen = new Set<string>();
    for (const [a, b] of BOX_EDGES) {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      seen.add(key);
    }
    expect(seen.size).toBe(12);
  });

  it('every edge connects two valid corner indices', () => {
    for (const [a, b] of BOX_EDGES) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(8);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(8);
      expect(a).not.toBe(b);
    }
  });
});

describe('pointInBox — inclusive bounds check', () => {
  const box = boxFromCorners([0, 0, 0], [1, 1, 1]);

  it('returns true for points strictly inside', () => {
    expect(pointInBox([0.5, 0.5, 0.5], box)).toBe(true);
  });

  it('returns true for points exactly on the box faces', () => {
    expect(pointInBox([0, 0.5, 0.5], box)).toBe(true);
    expect(pointInBox([1, 0.5, 0.5], box)).toBe(true);
    expect(pointInBox([0.5, 0.5, 1], box)).toBe(true);
  });

  it('returns false for points outside any axis', () => {
    expect(pointInBox([-0.01, 0.5, 0.5], box)).toBe(false);
    expect(pointInBox([0.5, 1.01, 0.5], box)).toBe(false);
    expect(pointInBox(Z(-0.01), box)).toBe(false);
  });
});

describe('countPointsInBox', () => {
  it('counts only the points whose all axes are inside', () => {
    const positions = new Float32Array([
      0.1, 0.1, 0.1,   // inside
      0.5, 0.5, 0.5,   // inside
      -1, 0, 0,        // outside in X
      0, 2, 0,         // outside in Y
      0, 0, 5,         // outside in Z
      1, 1, 1,         // on the max corner — inclusive
    ]);
    const box = boxFromCorners([0, 0, 0], [1, 1, 1]);
    expect(countPointsInBox(positions, box)).toBe(3);
  });

  it('returns 0 on an empty buffer', () => {
    const box = boxFromCorners([0, 0, 0], [1, 1, 1]);
    expect(countPointsInBox(new Float32Array(0), box)).toBe(0);
  });
});
