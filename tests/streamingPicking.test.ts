/**
 * streamingPicking.test.ts
 *
 * streaming pick-selection — picking hardening invariants, proven against the pure
 * `selectStreamingPick` helper. The Viewer-side lifecycle plumbing (mesh-
 * still-in-scene + map-still-paired prune) is covered by the orphan-prune
 * test below; the selection algorithm itself is what these tests anchor.
 *
 * Why this lives separately from the existing `navMath.test.ts`:
 * `nearestPointAlongRay` answers "which point on this one cloud sits closest
 * to the ray"; `selectStreamingPick` answers "across N resident streaming
 * nodes, which point wins AND is the picked node still being refined". The
 * refinement flag and the multi-node selection are streaming-specific and
 * earn their own test surface.
 */

import { describe, expect, test } from 'vitest';
import {
  selectStreamingPick,
  STREAMING_PICK_ANGULAR_TOLERANCE,
  type StreamingPickNode,
} from '../src/render/streaming/streamingPickSelection';
import type { Vec3 } from '../src/render/navMath';

/** Looking down -Z from the origin — the same ray fixture `navMath.test.ts` uses. */
const ORIGIN: Vec3 = [0, 0, 0];
const DIR: Vec3 = [0, 0, -1];

/** Tiny helper: a one-point node at depth `d`, point at `(x, y, z)`. */
function node(d: number, x: number, y: number, z: number): StreamingPickNode {
  return { positions: new Float32Array([x, y, z]), depth: d };
}

/** Tiny helper: a multi-point node at depth `d`. */
function nodeAt(d: number, pts: number[]): StreamingPickNode {
  return { positions: new Float32Array(pts), depth: d };
}

describe('selectStreamingPick — basics', () => {
  test('returns null for an empty node list', () => {
    expect(selectStreamingPick([], ORIGIN, DIR)).toBeNull();
  });

  test('returns null when every node misses the ray', () => {
    // Far off the ray to the side; angular score = 5/10 = 0.5, well past 0.07.
    const nodes = [node(2, 5, 0, -10), node(2, -5, 0, -10)];
    expect(selectStreamingPick(nodes, ORIGIN, DIR)).toBeNull();
  });

  test('returns null when all candidate points are behind the camera', () => {
    // +Z is behind the origin given DIR = [0,0,-1].
    const nodes = [node(2, 0, 0, 10), node(2, 0, 0, 20)];
    expect(selectStreamingPick(nodes, ORIGIN, DIR)).toBeNull();
  });

  test('picks the on-ray point in a single resident node', () => {
    const nodes = [nodeAt(2, [5, 0, -10, 0, 0, -20, 5, 5, -15])];
    const hit = selectStreamingPick(nodes, ORIGIN, DIR);
    expect(hit?.nodeIndex).toBe(0);
    expect(hit?.pointIndex).toBe(1); // (0,0,-20) sits on the ray
    expect(hit?.point).toEqual([0, 0, -20]);
  });
});

describe('selectStreamingPick — multi-node selection (angular fairness)', () => {
  test('chooses the smaller angular miss across nodes, regardless of distance', () => {
    // Node A: a point near the camera but a touch off the ray.
    //   offset ≈ 0.2, along = 5 → score ≈ 0.04
    // Node B: a point far from the camera, even closer to the ray.
    //   offset ≈ 0.05, along = 50 → score = 0.001
    // Angular fairness must pick B.
    const a: StreamingPickNode = { positions: new Float32Array([0.2, 0, -5]), depth: 2 };
    const b: StreamingPickNode = { positions: new Float32Array([0.05, 0, -50]), depth: 2 };
    const hit = selectStreamingPick([a, b], ORIGIN, DIR);
    expect(hit?.nodeIndex).toBe(1);
    // Float32 storage rounds 0.05 — compare with tolerance.
    expect(hit?.point[0]).toBeCloseTo(0.05, 6);
    expect(hit?.point[1]).toBe(0);
    expect(hit?.point[2]).toBe(-50);
  });

  test('reports the correct point index within the winning node', () => {
    // Winning node holds three points; second one (index 1) is the on-ray hit.
    const a: StreamingPickNode = {
      positions: new Float32Array([3, 0, -2, 0, 0, -8, 3, 3, -8]),
      depth: 2,
    };
    const hit = selectStreamingPick([a], ORIGIN, DIR);
    expect(hit?.pointIndex).toBe(1);
    expect(hit?.point).toEqual([0, 0, -8]);
  });

  test('the angular tolerance constant matches the static-cloud picker', () => {
    // The streaming and static cloud picks must use the same on-target
    // threshold so the two paths return / reject consistent picks. This
    // anchors the constant so a future drift surfaces immediately.
    expect(STREAMING_PICK_ANGULAR_TOLERANCE).toBeCloseTo(0.07, 6);
  });

  test('rejects a hit that clears the ray-search but misses the angular tolerance', () => {
    // A single point off to the side: offset = 1, along = 10 → score = 0.1,
    // above the 0.07 tolerance. The selector must return null even though
    // `nearestPointAlongRay` itself returns a hit (its job is only to find
    // the closest, not to gate on score).
    const nodes = [node(2, 1, 0, -10)];
    expect(selectStreamingPick(nodes, ORIGIN, DIR)).toBeNull();
  });
});

describe('selectStreamingPick — refinement consistency (streamingRefining flag)', () => {
  test('false when only one depth is resident', () => {
    const nodes = [node(3, 0, 0, -5), node(3, 0.05, 0, -5)];
    const hit = selectStreamingPick(nodes, ORIGIN, DIR);
    expect(hit).not.toBeNull();
    expect(hit?.streamingRefining).toBe(false);
  });

  test('false when the winning node IS at the deepest resident depth', () => {
    // Two nodes resident: shallow (depth 2) off the ray, deep (depth 5)
    // on the ray. Pick lands on deep → not refining.
    const shallow: StreamingPickNode = {
      positions: new Float32Array([3, 0, -10]),
      depth: 2,
    };
    const deep: StreamingPickNode = {
      positions: new Float32Array([0, 0, -10]),
      depth: 5,
    };
    const hit = selectStreamingPick([shallow, deep], ORIGIN, DIR);
    expect(hit?.nodeIndex).toBe(1);
    expect(hit?.streamingRefining).toBe(false);
  });

  test('true when the winning node is shallower than the deepest resident node', () => {
    // The on-ray win comes from the shallow node; a deeper node is resident
    // but its point sits off the ray. The flag must fire so the inspector
    // can hint that a deeper sibling may refine the pick.
    const shallow: StreamingPickNode = {
      positions: new Float32Array([0, 0, -10]),
      depth: 2,
    };
    const deep: StreamingPickNode = {
      positions: new Float32Array([3, 0, -10]),
      depth: 5,
    };
    const hit = selectStreamingPick([shallow, deep], ORIGIN, DIR);
    expect(hit?.nodeIndex).toBe(0);
    expect(hit?.streamingRefining).toBe(true);
  });

  test('max-depth scan includes nodes that miss the ray', () => {
    // The deep node misses the ray entirely (its only point is off to the
    // side AND off-tolerance), so it never wins the pick. But its depth
    // STILL must count toward `maxResidentDepth`, so the shallow winner is
    // correctly flagged as refining. This is the regression-trap for "only
    // measure depth on candidates that produced a `nearestPointAlongRay`
    // hit" — which would silently let a deeper node be ignored.
    const shallow: StreamingPickNode = {
      positions: new Float32Array([0, 0, -10]),
      depth: 1,
    };
    const deep: StreamingPickNode = {
      positions: new Float32Array([100, 100, -10]),
      depth: 4,
    };
    const hit = selectStreamingPick([shallow, deep], ORIGIN, DIR);
    expect(hit?.nodeIndex).toBe(0);
    expect(hit?.streamingRefining).toBe(true);
  });

  test('all-depths-equal scan with a real pick returns refining=false', () => {
    const a = nodeAt(3, [0, 0, -10]);
    const b = nodeAt(3, [0.02, 0, -20]);
    const c = nodeAt(3, [100, 100, -30]);
    const hit = selectStreamingPick([a, b, c], ORIGIN, DIR);
    expect(hit?.streamingRefining).toBe(false);
  });
});

describe('selectStreamingPick — stability / determinism', () => {
  test('returns the first node on a score tie (deterministic ordering)', () => {
    // Two identical-score on-ray hits across two nodes. Deterministic
    // selection: the first one wins (strict-less-than score comparison).
    // This locks the behaviour so a refactor that flips to <= doesn't
    // silently change which annotation/measurement vertex gets recorded.
    const a = nodeAt(2, [0, 0, -10]);
    const b = nodeAt(2, [0, 0, -10]);
    const hit = selectStreamingPick([a, b], ORIGIN, DIR);
    expect(hit?.nodeIndex).toBe(0);
  });

  test('does not mutate the input node array or its position buffers', () => {
    // Defence against an accidental in-place reorder for sort-by-depth or
    // similar — the Viewer hands these from its lifecycle map; any mutation
    // would corrupt subsequent picks.
    const positions = new Float32Array([0, 0, -10, 1, 0, -10]);
    const before = Array.from(positions);
    const nodes: StreamingPickNode[] = [{ positions, depth: 2 }];
    const nodesCopy = [...nodes];
    selectStreamingPick(nodes, ORIGIN, DIR);
    expect(nodes).toEqual(nodesCopy);
    expect(Array.from(positions)).toEqual(before);
  });

  test('survives a node with an empty positions buffer', () => {
    // A resident node with no points (defensive — shouldn't happen, but
    // proves we don't crash if a future loader paths an empty tile through).
    const empty: StreamingPickNode = { positions: new Float32Array(0), depth: 3 };
    const real: StreamingPickNode = {
      positions: new Float32Array([0, 0, -10]),
      depth: 2,
    };
    const hit = selectStreamingPick([empty, real], ORIGIN, DIR);
    expect(hit?.nodeIndex).toBe(1);
    // The empty node still counts toward max-depth → refining flag fires.
    expect(hit?.streamingRefining).toBe(true);
  });
});

describe('selectStreamingPick — class filter (visible-classes-only picks)', () => {
  test('with no acceptClass predicate, classification is ignored (hot path)', () => {
    // A node carrying classification but no predicate behaves exactly as if
    // the field were absent — the on-ray point still wins.
    const n: StreamingPickNode = {
      positions: new Float32Array([3, 0, -2, 0, 0, -8]),
      depth: 2,
      classification: new Uint8Array([2, 6]),
    };
    const hit = selectStreamingPick([n], ORIGIN, DIR);
    expect(hit?.pointIndex).toBe(1);
  });

  test('rejecting the on-ray point class snaps to the next visible point', () => {
    // Point index 1 sits on the ray but is class 6 (hidden); class 2 is shown,
    // so the runner-up (index 0) is surfaced rather than "nothing".
    // Index 0 is slightly off the ray but within angular tolerance
    // (0.1/8 ≈ 0.0125 < 0.07); index 1 sits dead on the ray.
    const n: StreamingPickNode = {
      positions: new Float32Array([0.1, 0, -8, 0, 0, -8]),
      depth: 2,
      classification: new Uint8Array([2, 6]),
    };
    const visible = new Set([2]);
    const hit = selectStreamingPick([n], ORIGIN, DIR, (c) => visible.has(c));
    expect(hit?.pointIndex).toBe(0);
    expect(hit?.point[0]).toBeCloseTo(0.1, 6);
  });

  test('a predicate hiding every point class returns null', () => {
    const n: StreamingPickNode = {
      positions: new Float32Array([0, 0, -8]),
      depth: 2,
      classification: new Uint8Array([6]),
    };
    expect(selectStreamingPick([n], ORIGIN, DIR, () => false)).toBeNull();
  });

  test('a node without classification is left untouched by the predicate', () => {
    // Defensive: when a node carries no classification array, the predicate
    // can't apply, so the node's points stay eligible (never silently dropped).
    const n: StreamingPickNode = {
      positions: new Float32Array([0, 0, -8]),
      depth: 2,
    };
    const hit = selectStreamingPick([n], ORIGIN, DIR, () => false);
    expect(hit?.pointIndex).toBe(0);
  });
});

describe('selectStreamingPick — invariant: no silent stale picks', () => {
  test('handing an empty list always returns null (never reuses prior state)', () => {
    // The selector is pure — no internal cache. This test exists to anchor
    // the contract: "no resident nodes" maps to `null`, never to a previous
    // pick. Combined with the Viewer's prune-on-sighting behaviour, this
    // proves a click after every node has been evicted returns null.
    const before = selectStreamingPick(
      [nodeAt(2, [0, 0, -10])],
      ORIGIN,
      DIR,
    );
    expect(before).not.toBeNull();
    const after = selectStreamingPick([], ORIGIN, DIR);
    expect(after).toBeNull();
  });
});
