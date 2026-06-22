/**
 * tests/volume.test.ts
 *
 * Coverage for the v0.3.7 cut/fill volume estimator. Pins the
 * polygon-area shoelace, the point-in-polygon ray-cast, the cut/fill
 * bucketing math, and the auto-reference Z heuristic.
 */

import { describe, it, expect } from 'vitest';
import {
  volumeCutFill,
  pointInPolygon2D,
  polygonHorizontalArea,
  autoReferenceZ,
} from '../src/render/measure/volume';

const Z_UP: [number, number, number] = [0, 0, 1];

/** Build an interleaved x/y/z Float32Array from a list of [x,y,z] tuples. */
function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

/** Build an N×N grid of points at constant Z covering a unit square. */
function packGrid(
  n: number,
  xRange: [number, number],
  yRange: [number, number],
  z: number,
): Float32Array {
  const pts: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = xRange[0] + ((xRange[1] - xRange[0]) * i) / (n - 1);
      const y = yRange[0] + ((yRange[1] - yRange[0]) * j) / (n - 1);
      pts.push([x, y, z]);
    }
  }
  return pack(pts);
}

describe('polygonHorizontalArea — shoelace formula', () => {
  it('returns 1 for a unit square', () => {
    const area = polygonHorizontalArea([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    expect(area).toBeCloseTo(1, 9);
  });

  it('returns zero for a degenerate (collinear) polygon', () => {
    const area = polygonHorizontalArea([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
    expect(area).toBeCloseTo(0, 9);
  });

  it('is sign-agnostic (CCW and CW give the same magnitude)', () => {
    const ccw = polygonHorizontalArea([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 1 },
    ]);
    const cw = polygonHorizontalArea([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 0 },
    ]);
    expect(ccw).toBeCloseTo(cw, 9);
    expect(ccw).toBeCloseTo(2, 9);
  });
});

describe('pointInPolygon2D — ray-cast inside test', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ];

  it('returns true for points strictly inside', () => {
    expect(pointInPolygon2D(1, 1, square)).toBe(true);
  });

  it('returns false for points strictly outside', () => {
    expect(pointInPolygon2D(-1, 1, square)).toBe(false);
    expect(pointInPolygon2D(3, 1, square)).toBe(false);
    expect(pointInPolygon2D(1, -1, square)).toBe(false);
  });

  it('handles a non-convex (L-shaped) polygon correctly', () => {
    const l = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
    ];
    // (0.5, 1.5) is inside the L's vertical arm; (1.5, 1.5) is outside.
    expect(pointInPolygon2D(0.5, 1.5, l)).toBe(true);
    expect(pointInPolygon2D(1.5, 1.5, l)).toBe(false);
  });

  it('returns false for an under-defined polygon', () => {
    expect(pointInPolygon2D(0, 0, [])).toBe(false);
    expect(pointInPolygon2D(0, 0, [{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(false);
  });
});

describe('volumeCutFill — pure fill case', () => {
  it('computes a flat fill mound correctly', () => {
    // 11×11 grid of points at z = 2 inside a 1m × 1m polygon at z = 0.
    // Expected fill volume = 1 m² × 2 m = 2 m³. No cut.
    const positions = packGrid(11, [0, 1], [0, 1], 2);
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      referenceZ: 0,
      up: Z_UP,
      positions,
    });
    expect(result.footprintArea).toBeCloseTo(1, 9);
    expect(result.fill).toBeCloseTo(2, 5);
    expect(result.cut).toBe(0);
    expect(result.net).toBeCloseTo(2, 5);
    // Most points land inside (the ray-cast is half-open on horizontal
    // edges by design; the per-point area auto-scales so the volume
    // result stays exact even when boundary samples drop). Assert at
    // least the strictly-interior 10×10 = 100 sample subset.
    expect(result.pointsInPolygon).toBeGreaterThanOrEqual(100);
  });
});

describe('volumeCutFill — pure cut case', () => {
  it('computes a flat cut basin correctly', () => {
    // 11×11 grid at z = −1 below a 1m × 1m polygon at z = 0.
    // Expected cut = 1 × 1 = 1 m³. No fill. Net = −1 m³.
    const positions = packGrid(11, [0, 1], [0, 1], -1);
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      referenceZ: 0,
      up: Z_UP,
      positions,
    });
    expect(result.fill).toBe(0);
    expect(result.cut).toBeCloseTo(1, 5);
    expect(result.net).toBeCloseTo(-1, 5);
  });
});

describe('volumeCutFill — mixed cut + fill', () => {
  it('separates the buckets correctly on a half-fill / half-cut polygon', () => {
    // Two grids on the strictly-interior side of the polygon edges so
    // every sample tests cleanly inside without sitting on a polygon
    // edge (the ray-cast inside test is half-open on horizontal edges
    // by design — fine in production at typical scan densities, but a
    // test fixture must avoid the boundary). Left half at z = 2 (fill),
    // right half at z = −2 (cut), polygon covers the full unit square.
    // Expected: fill ≈ cut ≈ 1 m³ each, net ≈ 0.
    const left = packGrid(11, [0.02, 0.48], [0.02, 0.98], 2);
    const right = packGrid(11, [0.52, 0.98], [0.02, 0.98], -2);
    const positions = new Float32Array(left.length + right.length);
    positions.set(left, 0);
    positions.set(right, left.length);
    const result = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      referenceZ: 0,
      up: Z_UP,
      positions,
    });
    expect(result.fill).toBeCloseTo(1, 5);
    expect(result.cut).toBeCloseTo(1, 5);
    expect(Math.abs(result.net)).toBeLessThan(1e-4);
  });
});

describe('volumeCutFill — Y-up clouds (phone-scan axis)', () => {
  const Y_UP: [number, number, number] = [0, 1, 0];

  // A Y-up fill mound: footprint spans x∈[0,1], z∈[0,1] (horizontal plane
  // for up=[0,1,0] projects to (x, −z)); the "height" is the Y coordinate.
  // 11×11 grid at y = 2 over a 1m × 1m footprint at y = 0 ⇒ fill = 1 × 2 = 2 m³.
  function packYUpGrid(n: number, y: number): Float32Array {
    const pts: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = i / (n - 1);
        const z = j / (n - 1);
        pts.push([x, y, z]);
      }
    }
    return pack(pts);
  }

  const yUpPolygon: ReadonlyArray<[number, number, number]> = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ];

  it('computes the fill mound correctly when given the Y up-axis', () => {
    const result = volumeCutFill({
      polygon: yUpPolygon,
      referenceZ: 0,
      up: Y_UP,
      positions: packYUpGrid(11, 2),
    });
    expect(result.footprintArea).toBeCloseTo(1, 9);
    expect(result.fill).toBeCloseTo(2, 5);
    expect(result.cut).toBe(0);
    expect(result.net).toBeCloseTo(2, 5);
    expect(result.pointsInPolygon).toBeGreaterThanOrEqual(100);
  });

  // Guards the wiring contract: the caller MUST pass the cloud's real up
  // axis. If the Viewer's volume sampler regresses to a hardcoded Z_UP
  // (the v0.4.4 audit B1 bug), the same Y-up cloud collapses to a
  // degenerate (collinear) footprint and the volume silently vanishes —
  // a confidently-wrong 0 m³. This pins that the up-axis is load-bearing.
  it('mis-computes the same Y-up cloud if forced to Z-up (regression guard)', () => {
    const result = volumeCutFill({
      polygon: yUpPolygon,
      referenceZ: 0,
      up: Z_UP,
      positions: packYUpGrid(11, 2),
    });
    expect(result.fill).not.toBeCloseTo(2, 1);
  });
});

describe('volumeCutFill — degenerate inputs', () => {
  it('returns zeros for an under-defined polygon', () => {
    const r = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      referenceZ: 0,
      positions: packGrid(5, [0, 1], [0, 1], 1),
    });
    expect(r.fill).toBe(0);
    expect(r.cut).toBe(0);
    expect(r.net).toBe(0);
    expect(r.pointsInPolygon).toBe(0);
  });

  it('returns zeros for an empty cloud', () => {
    const r = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      referenceZ: 0,
      positions: new Float32Array(0),
    });
    expect(r.fill).toBe(0);
    expect(r.cut).toBe(0);
    expect(r.net).toBe(0);
    expect(r.sampleCount).toBe(0);
  });

  it('reports zero pointsInPolygon when every sample is outside', () => {
    const positions = packGrid(5, [10, 11], [10, 11], 5);
    const r = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      referenceZ: 0,
      positions,
    });
    expect(r.pointsInPolygon).toBe(0);
    expect(r.fill).toBe(0);
    expect(r.cut).toBe(0);
  });
});

describe('volumeCutFill — confidence + density fields', () => {
  it('populates density = pointsInPolygon / footprintArea', () => {
    // Strictly-interior 10×10 grid → all 100 samples land inside the
    // unit polygon, density = 100 points / m².
    const positions = packGrid(10, [0.02, 0.98], [0.02, 0.98], 1);
    const r = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      referenceZ: 0,
      up: Z_UP,
      positions,
    });
    expect(r.density).toBeCloseTo(100, 5);
  });

  it('populates a finite medianAbsDelta when points landed inside', () => {
    const positions = packGrid(7, [0, 1], [0, 1], 3);
    const r = volumeCutFill({
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      referenceZ: 0,
      up: Z_UP,
      positions,
    });
    // All points at z = 3 → all |Δz| = 3.
    expect(r.medianAbsDelta).toBeCloseTo(3, 5);
  });
});

describe('autoReferenceZ — median-height suggestion', () => {
  it('returns the median Z of the polygon vertices', () => {
    const z = autoReferenceZ([
      [0, 0, 1],
      [1, 0, 5],
      [1, 1, 3],
      [0, 1, 7],
    ]);
    expect(z).toBeCloseTo(4, 9); // median of [1, 3, 5, 7] = 4
  });

  it('handles a single-vertex polygon', () => {
    expect(autoReferenceZ([[0, 0, 42]])).toBe(42);
  });

  it('returns 0 for an empty polygon', () => {
    expect(autoReferenceZ([])).toBe(0);
  });
});
