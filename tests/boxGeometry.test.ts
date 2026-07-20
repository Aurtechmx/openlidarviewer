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
import type { Vec3 } from '../src/render/measure/types';

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

// Review finding: box metrics hardcoded X=width / Y=depth / Z=height, which is
// wrong on a Y-up frame (phone-scan meshes: PLY/OBJ/GLB/glTF). It also made the
// export scale the WRONG extent by the vertical unit factor, and trace a
// vertical slice instead of the ground footprint.
describe('box measurements follow the scan up-axis', () => {
  // 2 wide (X), 3 deep (Z), 4 tall (Y) in a Y-up frame.
  const YUP: Vec3 = [0, 1, 0];
  const box = boxFromCorners([0, 0, 0], [2, 4, 3]);

  it('Z-up is unchanged: X=width, Y=depth, Z=height', () => {
    const m = boxMetrics(boxFromCorners([0, 0, 0], [2, 3, 4]));
    expect([m.width, m.depth, m.height]).toEqual([2, 3, 4]);
  });

  it('Y-up reads height off Y and the footprint off X and Z', () => {
    const m = boxMetrics(box, YUP);
    expect(m.height).toBe(4); // the Y span, not the Z span
    expect(m.width).toBe(2);
    expect(m.depth).toBe(3);
    expect(m.volume).toBe(24); // unchanged: the product is axis-order agnostic
  });

  it('the footprint ring is the low face along the up-axis', () => {
    // Corners 0..3 are what the GeoJSON/KML exporters trace as the footprint.
    const ring = boxCorners(box, YUP).slice(0, 4);
    // Every footprint corner sits at the BOTTOM of the Y span.
    expect(ring.every((c) => c[1] === 0)).toBe(true);
    // And it spans the two horizontal axes, X and Z.
    expect(new Set(ring.map((c) => c[0]))).toEqual(new Set([0, 2]));
    expect(new Set(ring.map((c) => c[2]))).toEqual(new Set([0, 3]));
  });

  it('Z-up corner order is byte-identical to the historical output', () => {
    const unit = boxFromCorners([0, 0, 0], [1, 1, 1]);
    expect(boxCorners(unit)).toEqual(boxCorners(unit, [0, 0, 1]));
    expect(boxCorners(unit)[0]).toEqual([0, 0, 0]);
    expect(boxCorners(unit)[2]).toEqual([1, 1, 0]);
  });

  /**
   * A box is axis-aligned by construction — it is stored as min/max corners, so
   * "height" can only mean the extent along one of X, Y, Z. Given a genuinely
   * tilted up vector there is no honest answer: the previous behaviour picked
   * the dominant component, which silently reported the extent along the
   * NEAREST axis as the height, and fed that number into the footprint ring,
   * the GeoJSON and KML polygons, and the compound-CRS vertical conversion.
   *
   * Refusing is the honest option until oriented boxes exist. Nothing in the
   * app can currently reach this — every `_worldUp` write is exactly (0,±1,0)
   * or (0,0,±1) — so the throw guards the contract, it does not gate a feature.
   */
  describe('a tilted frame is refused, not approximated', () => {
    const TILTED: Vec3 = [0.1, 0.97, 0.2];

    it('boxMetrics refuses a tilted up vector', () => {
      expect(() => boxMetrics(box, TILTED)).toThrow(/axis-aligned/i);
    });

    it('boxCorners refuses a tilted up vector', () => {
      expect(() => boxCorners(box, TILTED)).toThrow(/axis-aligned/i);
    });

    it('the message names the offending vector so a caller can see why', () => {
      expect(() => boxMetrics(box, TILTED)).toThrow(/0\.1/);
    });

    it('refuses a zero or non-finite up vector rather than dividing by its length', () => {
      expect(() => boxMetrics(box, [0, 0, 0])).toThrow(/axis-aligned/i);
      expect(() => boxMetrics(box, [0, NaN, 0])).toThrow(/axis-aligned/i);
    });

    it('accepts every exact axis, in both directions', () => {
      for (const up of [
        [1, 0, 0], [0, 1, 0], [0, 0, 1],
        [-1, 0, 0], [0, -1, 0], [0, 0, -1],
      ] as Vec3[]) {
        expect(() => boxMetrics(box, up)).not.toThrow();
        expect(() => boxCorners(box, up)).not.toThrow();
      }
    });

    it('accepts a normalised axis carrying float noise', () => {
      // Real up vectors arrive through matrix maths, so an exact 0 is not
      // guaranteed; a hair off-axis is still unambiguously that axis.
      expect(() => boxMetrics(box, [1e-9, 1e-9, 0.9999999999])).not.toThrow();
    });

    it('a 45-degree vector is ambiguous and refused, not rounded to one side', () => {
      const r = Math.SQRT1_2;
      expect(() => boxMetrics(box, [0, r, r])).toThrow(/axis-aligned/i);
    });
  });
});
