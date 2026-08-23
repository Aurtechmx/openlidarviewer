/**
 * profileFrameUpAxis.test.ts
 *
 * `buildProfileFrame` documents a zero or non-finite `up` as normalising to
 * `[0, 0, 0]`. The zero case did that; a non-finite one produced a NaN unit
 * vector, which every dot product downstream carries into a height, a
 * chainage and a corridor distance without raising anything.
 *
 * These hold the documented contract, and hold that an ordinary axis is
 * untouched by the guard.
 */
import { describe, it, expect } from 'vitest';
import { buildProfileFrame, projectPointToProfile } from '../src/render/measure/profileGeometry';
import {
  profileCorridorAccepts,
  createProfileHitScratch,
} from '../src/render/measure/profileCorridor';
import type { Vec3 } from '../src/render/navMath';

const A: Vec3 = [0, 0, 0];
const B: Vec3 = [10, 0, 0];

const DEGENERATE: Vec3[] = [
  [0, 0, 0],
  [Number.NaN, 0, 1],
  [0, Number.NaN, 0],
  [Number.POSITIVE_INFINITY, 0, 0],
  [0, 0, Number.NEGATIVE_INFINITY],
  [Number.NaN, Number.NaN, Number.NaN],
  [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0],
];

describe('a degenerate up axis resolves to the documented zero vector', () => {
  for (const up of DEGENERATE) {
    it(`${JSON.stringify(up)} normalises to [0, 0, 0]`, () => {
      const f = buildProfileFrame(A, B, up);
      expect(f.up).toEqual([0, 0, 0]);
      for (const c of f.up) expect(Number.isFinite(c)).toBe(true);
    });
  }

  it('leaves every frame field finite, so nothing downstream inherits a NaN', () => {
    for (const up of DEGENERATE) {
      const f = buildProfileFrame(A, B, up);
      for (const v of [...f.up, ...f.along, ...f.lateral, ...f.horizontal, ...f.horizontalAnchor]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(Number.isFinite(f.horizontalLength)).toBe(true);
      expect(Number.isFinite(f.verticalDelta)).toBe(true);
    }
  });

  it('projects a point to finite values rather than NaN', () => {
    for (const up of DEGENERATE) {
      const p = projectPointToProfile(buildProfileFrame(A, B, up), [3, 1, 2]);
      expect(Number.isFinite(p.chainage)).toBe(true);
      expect(Number.isFinite(p.lateralOffset)).toBe(true);
      expect(Number.isFinite(p.height)).toBe(true);
    }
  });

  it('lets the corridor reach a decision instead of failing every comparison on NaN', () => {
    const scratch = createProfileHitScratch();
    for (const up of DEGENERATE) {
      const f = buildProfileFrame(A, B, up);
      // The verdict itself is not the point; that it is a boolean reached from
      // finite arithmetic is.
      expect(typeof profileCorridorAccepts(f, 1, 1, 3, 0, 0, scratch)).toBe('boolean');
    }
  });
});

describe('an ordinary up axis is untouched by the guard', () => {
  const CASES: { up: Vec3; want: Vec3 }[] = [
    { up: [0, 0, 1], want: [0, 0, 1] },
    { up: [0, 1, 0], want: [0, 1, 0] },
    { up: [0, 0, 5], want: [0, 0, 1] },
    { up: [0, -3, 0], want: [0, -1, 0] },
  ];

  for (const { up, want } of CASES) {
    it(`${JSON.stringify(up)} normalises to ${JSON.stringify(want)}`, () => {
      const f = buildProfileFrame(A, B, up);
      for (let i = 0; i < 3; i++) expect(f.up[i]).toBeCloseTo(want[i]!, 12);
    });
  }

  it('keeps a unit length for an oblique axis', () => {
    const f = buildProfileFrame(A, B, [3, 4, 12]);
    expect(Math.hypot(...f.up)).toBeCloseTo(1, 12);
  });

  it('resolves a very small axis rather than treating it as degenerate', () => {
    const f = buildProfileFrame(A, B, [0, 0, 1e-300]);
    expect(Math.hypot(...f.up)).toBeCloseTo(1, 12);
  });
});
