/**
 * snap.test.ts — the pure "snap" core: snapping a measurement point to the
 * nearest ACTUAL cloud return (a real measured datum, with pointIndex) vs to
 * CONSTRUCTED measurement geometry (endpoint / midpoint / segment crossing,
 * never a pointIndex). Covers determinism, range gating, and degenerate input.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPointSnapIndex,
  snapToNearestPoint,
  countPointsWithinRadius,
  snapToVertices,
  snapToMidpoints,
  snapToIntersections,
  snapBest,
  type Segments,
} from '../src/render/measure/snap';

/** Build an interleaved Float32Array from a list of xyz tuples. */
function cloud(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  });
  return out;
}

describe('snapToNearestPoint — nearest ACTUAL cloud return', () => {
  // A small known grid of points.
  const positions = cloud([
    [0, 0, 0], // 0
    [1, 0, 0], // 1
    [0, 1, 0], // 2
    [5, 5, 5], // 3
    [10, 0, 0], // 4
  ]);
  const index = buildPointSnapIndex(positions);

  it('snaps a query to the nearest point with the right pointIndex', () => {
    const r = snapToNearestPoint(index, [0.9, 0.05, 0], 1);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('point');
    expect(r!.pointIndex).toBe(1);
    expect(r!.position).toEqual([1, 0, 0]);
    expect(r!.distance).toBeCloseTo(Math.hypot(0.1, 0.05, 0), 6);
  });

  it('a real point snap always carries a pointIndex', () => {
    const r = snapToNearestPoint(index, [4.9, 5.1, 5], 1);
    expect(r!.kind).toBe('point');
    expect(typeof r!.pointIndex).toBe('number');
    expect(r!.pointIndex).toBe(3);
  });

  it('returns null when the nearest point is beyond maxDistance', () => {
    // Nearest is index 0/1/2 at ~2 units; cap well under that.
    const r = snapToNearestPoint(index, [3, 3, 0], 0.5);
    expect(r).toBeNull();
  });

  it('tie-break is deterministic: lowest index wins on an exact tie', () => {
    // Two equidistant points (indices 0 and 1) from the midpoint query.
    const tie = buildPointSnapIndex(cloud([
      [0, 0, 0], // 0
      [2, 0, 0], // 1
    ]));
    const r = snapToNearestPoint(tie, [1, 0, 0], 5);
    expect(r!.pointIndex).toBe(0);
    expect(r!.distance).toBeCloseTo(1, 6);
  });

  it('empty cloud → null', () => {
    const empty = buildPointSnapIndex(new Float32Array(0));
    expect(snapToNearestPoint(empty, [0, 0, 0], 100)).toBeNull();
    expect(empty.count).toBe(0);
  });

  it('finds a point even when query lands far outside the grid bounds', () => {
    const r = snapToNearestPoint(index, [100, 0, 0], 200);
    expect(r!.pointIndex).toBe(4); // [10,0,0] is nearest to [100,0,0]
  });
});

describe('snapToVertices — measurement endpoints (constructed)', () => {
  const segments: Segments = [
    [[0, 0, 0], [10, 0, 0]],
    [[0, 10, 2], [10, 10, 2]],
  ];

  it('lands on the nearest vertex with kind endpoint and the right distance', () => {
    const r = snapToVertices(segments, [0.2, 0.1, 0], 1);
    expect(r!.kind).toBe('endpoint');
    expect(r!.position).toEqual([0, 0, 0]);
    expect(r!.distance).toBeCloseTo(Math.hypot(0.2, 0.1, 0), 6);
    expect(r!.pointIndex).toBeUndefined(); // never a measured return
  });

  it('returns null when no vertex is within range', () => {
    expect(snapToVertices(segments, [5, 5, 5], 1)).toBeNull();
  });

  it('empty segment set → null', () => {
    expect(snapToVertices([], [0, 0, 0], 10)).toBeNull();
  });
});

describe('snapToMidpoints — segment midpoints (constructed)', () => {
  const segments: Segments = [[[0, 0, 0], [10, 0, 0]]];

  it('lands on the segment midpoint with kind midpoint', () => {
    const r = snapToMidpoints(segments, [5.1, 0.1, 0], 1);
    expect(r!.kind).toBe('midpoint');
    expect(r!.position).toEqual([5, 0, 0]);
    expect(r!.distance).toBeCloseTo(Math.hypot(0.1, 0.1, 0), 6);
    expect(r!.pointIndex).toBeUndefined();
  });

  it('returns null when the midpoint is out of range', () => {
    expect(snapToMidpoints(segments, [5, 5, 0], 1)).toBeNull();
  });

  it('a single-vertex polyline has no segment, hence no midpoint → null', () => {
    expect(snapToMidpoints([[[0, 0, 0]]], [0, 0, 0], 10)).toBeNull();
  });
});

describe('snapToIntersections — XY segment crossings (constructed)', () => {
  it('two crossing segments intersect at the crossing point', () => {
    const segments: Segments = [
      [[-1, 0, 0], [1, 0, 0]],   // along X through origin
      [[0, -1, 4], [0, 1, 4]],   // along Y through origin, z=4
    ];
    const r = snapToIntersections(segments, [0, 0, 2], 1);
    expect(r!.kind).toBe('intersection');
    expect(r!.position[0]).toBeCloseTo(0, 6);
    expect(r!.position[1]).toBeCloseTo(0, 6);
    expect(r!.position[2]).toBeCloseTo(2, 6); // z averaged: (0 + 4) / 2
    expect(r!.pointIndex).toBeUndefined();
  });

  it('parallel / non-touching segments → null', () => {
    const parallel: Segments = [
      [[0, 0, 0], [10, 0, 0]],
      [[0, 1, 0], [10, 1, 0]],
    ];
    expect(snapToIntersections(parallel, [5, 0.5, 0], 100)).toBeNull();
  });

  it('segments that would cross only if extended (not within spans) → null', () => {
    const disjoint: Segments = [
      [[0, 0, 0], [1, 0, 0]],   // short X stub near origin
      [[5, -1, 0], [5, 1, 0]],  // Y line at x=5
    ];
    expect(snapToIntersections(disjoint, [5, 0, 0], 100)).toBeNull();
  });

  it('crossing exists but is beyond maxDistance → null', () => {
    const segments: Segments = [
      [[-1, 0, 0], [1, 0, 0]],
      [[0, -1, 0], [0, 1, 0]],
    ];
    expect(snapToIntersections(segments, [10, 10, 0], 1)).toBeNull();
  });
});

describe('snapBest — closest across all, preferring a real point on a near-tie', () => {
  const positions = cloud([[5, 0, 0]]); // a real return at the segment midpoint
  const index = buildPointSnapIndex(positions);
  const segments: Segments = [[[0, 0, 0], [10, 0, 0]]]; // midpoint also at [5,0,0]

  it('prefers the real point snap when a geometry feature is coincident', () => {
    const r = snapBest(index, segments, [5, 0, 0], 1);
    expect(r!.kind).toBe('point');
    expect(r!.pointIndex).toBe(0);
  });

  it('picks a clearly-closer geometry snap over a far point', () => {
    const farPoint = buildPointSnapIndex(cloud([[100, 100, 100]]));
    const r = snapBest(farPoint, segments, [0.1, 0, 0], 1);
    expect(r!.kind).toBe('endpoint');
    expect(r!.position).toEqual([0, 0, 0]);
  });

  it('returns null when nothing is in range', () => {
    expect(snapBest(index, segments, [50, 50, 50], 1)).toBeNull();
  });
});

describe('edge cases — maxDistance 0, single point, zero-length segment', () => {
  it('maxDistance 0 → null even when a point is exactly under the query', () => {
    const index = buildPointSnapIndex(cloud([[0, 0, 0]]));
    expect(snapToNearestPoint(index, [0, 0, 0], 0)).toBeNull();
    expect(snapToVertices([[[0, 0, 0]]], [0, 0, 0], 0)).toBeNull();
    expect(snapBest(index, [[[0, 0, 0]]], [0, 0, 0], 0)).toBeNull();
  });

  it('single-point cloud snaps when in range', () => {
    const index = buildPointSnapIndex(cloud([[3, 4, 0]]));
    expect(index.count).toBe(1);
    const r = snapToNearestPoint(index, [0, 0, 0], 10);
    expect(r!.pointIndex).toBe(0);
    expect(r!.distance).toBeCloseTo(5, 6);
    expect(snapToNearestPoint(index, [0, 0, 0], 4)).toBeNull();
  });

  it('zero-length segment: midpoint equals the coincident endpoint', () => {
    const segments: Segments = [[[2, 2, 2], [2, 2, 2]]];
    const mid = snapToMidpoints(segments, [2, 2, 2], 1);
    expect(mid!.kind).toBe('midpoint');
    expect(mid!.position).toEqual([2, 2, 2]);
    const vert = snapToVertices(segments, [2, 2, 2], 1);
    expect(vert!.position).toEqual([2, 2, 2]);
  });

  it('zero-length segment never produces a phantom intersection', () => {
    const segments: Segments = [
      [[0, 0, 0], [0, 0, 0]],   // degenerate
      [[-1, 0, 0], [1, 0, 0]],
    ];
    expect(snapToIntersections(segments, [0, 0, 0], 100)).toBeNull();
  });
});

describe('countPointsWithinRadius', () => {
  it('counts the measured returns inside the radius (and excludes those outside)', () => {
    // A 3x3 grid of points spaced 1 unit apart, centred on origin.
    const pts: Array<readonly [number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) pts.push([x, y, 0]);
    const index = buildPointSnapIndex(cloud(pts));

    // radius 0.5 around origin → only the centre point.
    expect(countPointsWithinRadius(index, [0, 0, 0], 0.5)).toBe(1);
    // radius 1.01 → centre + 4 axis neighbours (the 4 diagonals are ~1.414 away).
    expect(countPointsWithinRadius(index, [0, 0, 0], 1.01)).toBe(5);
    // radius spanning the whole grid → all 9.
    expect(countPointsWithinRadius(index, [0, 0, 0], 5)).toBe(9);
  });

  it('returns 0 in an empty neighbourhood (a void) and on a 0 radius', () => {
    const index = buildPointSnapIndex(cloud([[0, 0, 0], [1, 0, 0]]));
    expect(countPointsWithinRadius(index, [100, 100, 100], 1)).toBe(0);
    expect(countPointsWithinRadius(index, [0, 0, 0], 0)).toBe(0);
  });
});
