/**
 * tests/classificationEditor.test.ts
 *
 * Unit coverage for the v0.3.7 classification mutators: global swap,
 * polygon re-classify, and the snapshot/restore helpers the undo path
 * uses.
 */

import { describe, it, expect } from 'vitest';
import {
  applyClassSwap,
  applyPolygonReclassify,
  applyIndexReclassify,
  snapshotClassification,
  restoreClassification,
} from '../src/render/measure/classificationEditor';

function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

describe('applyClassSwap — global remap', () => {
  it('rewrites every matching class and counts the change', () => {
    const cls = new Uint8Array([1, 2, 1, 3, 1, 2]);
    const r = applyClassSwap(cls, 1, 7);
    expect(Array.from(cls)).toEqual([7, 2, 7, 3, 7, 2]);
    expect(r.changedCount).toBe(3);
    expect(r.pointCount).toBe(6);
  });

  it('is a no-op when fromClass equals toClass', () => {
    const cls = new Uint8Array([2, 2, 2]);
    const r = applyClassSwap(cls, 2, 2);
    expect(Array.from(cls)).toEqual([2, 2, 2]);
    expect(r.changedCount).toBe(0);
  });

  it('reports zero changes when no point matches the source class', () => {
    const cls = new Uint8Array([1, 2, 3]);
    const r = applyClassSwap(cls, 9, 5);
    expect(Array.from(cls)).toEqual([1, 2, 3]);
    expect(r.changedCount).toBe(0);
  });

  it('handles an empty buffer without throwing', () => {
    const cls = new Uint8Array(0);
    const r = applyClassSwap(cls, 1, 2);
    expect(r.changedCount).toBe(0);
    expect(r.pointCount).toBe(0);
  });
});

describe('applyPolygonReclassify — spatial remap', () => {
  /** Build a small fixture: 4 points, two inside a unit square, two outside. */
  function fixture(): {
    classification: Uint8Array;
    positions: Float32Array;
    polygon: [number, number, number][];
  } {
    return {
      classification: new Uint8Array([1, 2, 3, 4]),
      positions: pack([
        [0.5, 0.5, 0], // inside
        [0.25, 0.75, 0], // inside
        [10, 10, 0], // outside
        [-5, 0, 0], // outside
      ]),
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
    };
  }

  it('rewrites only the points whose XY projection is inside the polygon', () => {
    const f = fixture();
    const r = applyPolygonReclassify({
      classification: f.classification,
      positions: f.positions,
      polygon: f.polygon,
      newClass: 9,
    });
    expect(Array.from(f.classification)).toEqual([9, 9, 3, 4]);
    expect(r.changedCount).toBe(2);
  });

  it('does not change points that already carry the target class', () => {
    const f = fixture();
    f.classification[0] = 9; // first point already target
    const r = applyPolygonReclassify({
      classification: f.classification,
      positions: f.positions,
      polygon: f.polygon,
      newClass: 9,
    });
    expect(r.changedCount).toBe(1);
    expect(f.classification[0]).toBe(9);
  });

  it('honours an inclusion predicate', () => {
    const f = fixture();
    // Only re-classify points currently class 1 → 9. Second point is
    // class 2 and stays.
    const r = applyPolygonReclassify({
      classification: f.classification,
      positions: f.positions,
      polygon: f.polygon,
      newClass: 9,
      includeIf: (cls) => cls === 1,
    });
    expect(Array.from(f.classification)).toEqual([9, 2, 3, 4]);
    expect(r.changedCount).toBe(1);
  });

  it('returns zero changes for an under-defined polygon', () => {
    const f = fixture();
    const r = applyPolygonReclassify({
      classification: f.classification,
      positions: f.positions,
      polygon: [[0, 0, 0], [1, 0, 0]],
      newClass: 9,
    });
    expect(r.changedCount).toBe(0);
    expect(Array.from(f.classification)).toEqual([1, 2, 3, 4]);
  });

  it('returns zero changes for an empty cloud', () => {
    const r = applyPolygonReclassify({
      classification: new Uint8Array(0),
      positions: new Float32Array(0),
      polygon: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
      newClass: 9,
    });
    expect(r.changedCount).toBe(0);
    expect(r.pointCount).toBe(0);
  });
});

describe('applyPolygonReclassify — non-Z-up projection', () => {
  // For a non-Z-up `up`, the polygon is projected onto an (east, north) basis
  // perpendicular to `up`; every point MUST be projected onto that SAME basis
  // (all three components, height included) before the point-in-polygon test.
  // Testing a point with its raw (x, y) — ignoring the real projection and the
  // z component — reclassifies the wrong points for rotated / Y-up / tilted /
  // non-origin scans. These cases pin the correct, height-invariant behaviour.

  it('is height-invariant for a Y-up scan (up = [0,1,0])', () => {
    // up=[0,1,0] ⇒ projection is (x, -z); the height axis y must be ignored.
    // A unit square in the XZ ground plane (any height H), projects to the
    // square x∈[0,1], -z∈[-1,0] i.e. z∈[0,1].
    const H = 5;
    const polygon: [number, number, number][] = [
      [0, H, 0],
      [1, H, 0],
      [1, H, 1],
      [0, H, 1],
    ];
    const classification = new Uint8Array([1, 2, 3, 4]);
    const positions = pack([
      [0.5, 50, 0.5], // inside (x,z); height 50 must not matter
      [0.25, -30, 0.75], // inside (x,z); height -30 must not matter
      [10, 0, 0.5], // outside in x
      [0.5, 0, 5], // outside in z (depth)
    ]);
    const r = applyPolygonReclassify({
      classification,
      positions,
      polygon,
      newClass: 9,
      up: [0, 1, 0],
    });
    expect(Array.from(classification)).toEqual([9, 9, 3, 4]);
    expect(r.changedCount).toBe(2);
  });

  it('projects points onto the tilted basis, not raw XY (up = [0, √½, √½])', () => {
    // up=[0,s,s], s=1/√2 ⇒ east=[1,0,0], north=[0,s,-s]; projection is
    // (x, s·(y−z)). The two points below share the SAME projection (0.5, 0.5)
    // but very different raw y, so a raw-XY test would (wrongly) reject them.
    const s = Math.SQRT1_2;
    const d = 0.5 / s; // y−z that yields north-coord 0.5
    const polygon: [number, number, number][] = [
      [0, 0, 0], // → (0,0)
      [1, 0, 0], // → (1,0)
      [1, Math.SQRT2, 0], // → (1,1)
      [0, Math.SQRT2, 0], // → (0,1)
    ];
    const classification = new Uint8Array([1, 2, 3]);
    const positions = pack([
      [0.5, d, 0], // inside, small height
      [0.5, 100 + d, 100], // inside, large height (raw y≈100 would be rejected)
      [2, d, 0], // outside in x
    ]);
    const r = applyPolygonReclassify({
      classification,
      positions,
      polygon,
      newClass: 9,
      up: [0, s, s],
    });
    expect(Array.from(classification)).toEqual([9, 9, 3]);
    expect(r.changedCount).toBe(2);
  });

  it('is translation-consistent when points and polygon share the frame (Y-up, non-origin)', () => {
    // Same Y-up geometry as above, shifted by a large offset on every axis.
    // Projection is linear, so shifting points AND polygon equally preserves
    // membership — selection must be unchanged.
    const T = [1000, 2000, 3000] as const;
    const off = (p: readonly number[]): [number, number, number] => [
      p[0] + T[0],
      p[1] + T[1],
      p[2] + T[2],
    ];
    const polygon: [number, number, number][] = [
      [0, 5, 0],
      [1, 5, 0],
      [1, 5, 1],
      [0, 5, 1],
    ].map(off);
    const classification = new Uint8Array([1, 2, 3, 4]);
    const positions = pack(
      [
        [0.5, 50, 0.5],
        [0.25, -30, 0.75],
        [10, 0, 0.5],
        [0.5, 0, 5],
      ].map(off),
    );
    const r = applyPolygonReclassify({
      classification,
      positions,
      polygon,
      newClass: 9,
      up: [0, 1, 0],
    });
    expect(Array.from(classification)).toEqual([9, 9, 3, 4]);
    expect(r.changedCount).toBe(2);
  });

  it('handles a flipped up axis via the aux-branch fallback (up = [0,0,-1])', () => {
    // |uz| ≥ 0.99 selects aux=[1,0,0]; up=[0,0,-1] ⇒ east=[0,-1,0],
    // north=[-1,0,0], projection (−y, −x). The polygon below projects to the
    // unit square [0,1]²; the point projects to (0.5,0.5) inside (raw XY would
    // be (−0.5,−0.5), outside).
    const polygon: [number, number, number][] = [
      [0, 0, 0], // → (0,0)
      [0, -1, 0], // → (1,0)
      [-1, -1, 0], // → (1,1)
      [-1, 0, 0], // → (0,1)
    ];
    const classification = new Uint8Array([1, 2]);
    const positions = pack([
      [-0.5, -0.5, 77], // → (0.5,0.5) inside; z ignored
      [-0.5, -0.5, -3], // same horizontal → also inside (control on z-invariance)
    ]);
    const r = applyPolygonReclassify({
      classification,
      positions,
      polygon,
      newClass: 9,
      up: [0, 0, -1],
    });
    expect(Array.from(classification)).toEqual([9, 9]);
    expect(r.changedCount).toBe(2);
  });

  it('still honours includeIf and the already-target short-circuit under non-Z-up', () => {
    const polygon: [number, number, number][] = [
      [0, 5, 0],
      [1, 5, 0],
      [1, 5, 1],
      [0, 5, 1],
    ];
    const classification = new Uint8Array([1, 2, 9]); // third already target
    const positions = pack([
      [0.5, 50, 0.5], // inside, class 1 → eligible
      [0.25, -30, 0.75], // inside, class 2 → excluded by filter
      [0.75, 10, 0.25], // inside, class 9 → already target, no change
    ]);
    const r = applyPolygonReclassify({
      classification,
      positions,
      polygon,
      newClass: 9,
      up: [0, 1, 0],
      includeIf: (cls) => cls === 1,
    });
    expect(Array.from(classification)).toEqual([9, 2, 9]);
    expect(r.changedCount).toBe(1);
  });
});

describe('snapshotClassification / restoreClassification — undo helpers', () => {
  it('round-trips an unmodified buffer byte-for-byte', () => {
    const before = new Uint8Array([1, 2, 3, 4, 5]);
    const snap = snapshotClassification(before);
    // Mutate the original.
    applyClassSwap(before, 1, 9);
    expect(before[0]).toBe(9);
    // Restore.
    restoreClassification(before, snap);
    expect(Array.from(before)).toEqual([1, 2, 3, 4, 5]);
  });

  it('snapshot is independent of the source (mutating original does not affect snap)', () => {
    const cls = new Uint8Array([1, 2, 3]);
    const snap = snapshotClassification(cls);
    cls[0] = 99;
    expect(snap[0]).toBe(1);
  });

  it('throws when target and snapshot lengths disagree', () => {
    const target = new Uint8Array(3);
    const snap = new Uint8Array(5);
    expect(() => restoreClassification(target, snap)).toThrow();
  });
});

describe('applyIndexReclassify', () => {
  it('sets only the listed indices and counts real changes', () => {
    const cls = Uint8Array.from([1, 1, 1, 1, 1]);
    const r = applyIndexReclassify(cls, [1, 3], 6);
    expect(Array.from(cls)).toEqual([1, 6, 1, 6, 1]);
    expect(r.changedCount).toBe(2);
    expect(r.pointCount).toBe(5);
  });

  it('does not count an index already at the target class', () => {
    const cls = Uint8Array.from([6, 1]);
    expect(applyIndexReclassify(cls, [0, 1], 6).changedCount).toBe(1);
  });

  it('skips out-of-range indices defensively', () => {
    const cls = Uint8Array.from([1, 1]);
    const r = applyIndexReclassify(cls, [-1, 0, 99], 2);
    expect(Array.from(cls)).toEqual([2, 1]);
    expect(r.changedCount).toBe(1);
  });

  it('an empty selection is a no-op', () => {
    const cls = Uint8Array.from([1, 2, 3]);
    expect(applyIndexReclassify(cls, [], 9).changedCount).toBe(0);
    expect(Array.from(cls)).toEqual([1, 2, 3]);
  });
});
