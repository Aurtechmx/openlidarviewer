/**
 * transformStore.test.ts — non-destructive Float64 placement store.
 */

import { describe, it, expect } from 'vitest';
import { TransformStore, compose, IDENTITY, type RigidTransform, type Vec3, type Mat3 } from '../src/registration/transformStore';

const rotZ = (a: number): Mat3 => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const T = (R: Mat3, t: Vec3): RigidTransform => ({ R, t });

describe('TransformStore is non-destructive and reversible', () => {
  it('starts at identity; place() is a no-op before any transform', () => {
    const s = new TransformStore();
    expect(s.depth).toBe(0);
    expect(s.place([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('applies a placement without mutating the source, and undo restores it exactly', () => {
    const s = new TransformStore();
    const p: Vec3 = [1, 0, 0];
    s.apply(T(rotZ(Math.PI / 2), [5, 0, 0]));
    const placed = s.place(p);
    expect(placed[0]).toBeCloseTo(5, 9); // rot 90° then +5 in x
    expect(placed[1]).toBeCloseTo(1, 9);
    // The source is untouched — the store holds the transform, not the points.
    expect(p).toEqual([1, 0, 0]);
    s.undo();
    expect(s.depth).toBe(0);
    expect(s.place(p)).toEqual([1, 0, 0]); // exact original recovered
  });

  it('composes multiple placements in Float64 and undo peels them one at a time', () => {
    const s = new TransformStore();
    s.apply(T(rotZ(0.1), [0, 0, 0]));
    s.apply(T(rotZ(0.2), [0, 0, 0]));
    expect(s.depth).toBe(2);
    // Composed rotation ≈ 0.3 rad about z.
    const got = s.place([1, 0, 0]);
    expect(Math.atan2(got[1], got[0])).toBeCloseTo(0.3, 9);
    s.undo();
    expect(s.depth).toBe(1);
    expect(Math.atan2(s.place([1, 0, 0])[1], s.place([1, 0, 0])[0])).toBeCloseTo(0.1, 9);
  });

  it('reset returns to identity; the original is always recoverable', () => {
    const s = new TransformStore();
    s.apply(T(rotZ(1), [9, 9, 9]));
    s.apply(T(rotZ(1), [1, 1, 1]));
    s.reset();
    expect(s.depth).toBe(0);
    expect(s.place([2, 2, 2])).toEqual([2, 2, 2]);
  });

  it('bake records that an export carries the transform but does not touch the store', () => {
    const s = new TransformStore();
    s.apply(T(rotZ(0.5), [1, 2, 3]));
    expect(s.isBaked).toBe(false);
    const baked = s.bake();
    expect(s.isBaked).toBe(true);
    // The store is still usable and non-destructive after baking.
    expect(s.current()).toEqual(baked);
    s.undo();
    expect(s.depth).toBe(0);
  });
});

describe('compose', () => {
  it('identity is the neutral element', () => {
    const a = T(rotZ(0.7), [3, 4, 5]);
    expect(compose(IDENTITY, a)).toEqual(a);
    const c = compose(a, IDENTITY);
    expect(c.t).toEqual(a.t);
  });
});
