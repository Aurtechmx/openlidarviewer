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

/**
 * The store hands out its own stacked objects by reference (undo restores a
 * previous placement by popping to it), so a caller holding one must not be able
 * to write through it. `readonly` binds at compile time only; these drive the
 * cast that gets past it and check the consequence at place(), not just
 * Object.isFrozen.
 */
describe('a placement handed out cannot rewrite the store', () => {
  const stacked = (): TransformStore => {
    const s = new TransformStore();
    s.apply(T(rotZ(Math.PI / 3), [10, 20, 30]));
    return s;
  };
  const P: Vec3 = [1, 2, 3];
  const sameVec = (a: Vec3, b: Vec3): boolean => a.every((v, i) => Object.is(v, b[i]));

  /** Every level a cast can reach: a row element, a row slot, t, and R itself. */
  const expectWritesRejected = (x: RigidTransform): void => {
    expect(() => { (x.R as unknown as number[][])[0][0] = 2; }).toThrow(TypeError);
    expect(() => { (x.R as unknown as Vec3[])[1] = [9, 9, 9]; }).toThrow(TypeError);
    expect(() => { (x.t as unknown as number[])[2] = 999; }).toThrow(TypeError);
    expect(() => { (x as { R: Mat3 }).R = rotZ(1); }).toThrow(TypeError);
    expect(() => { (x as { t: Vec3 }).t = [7, 7, 7]; }).toThrow(TypeError);
  };

  it('rejects a cast write through bake() and leaves place() unchanged', () => {
    const s = stacked();
    const before = s.place(P);
    expect(sameVec(before, P)).toBe(false); // the placement is doing something
    expectWritesRejected(s.bake());
    expect(sameVec(s.place(P), before)).toBe(true);
  });

  it('rejects a cast write through current() and leaves place() unchanged', () => {
    const s = stacked();
    const before = s.place(P);
    expectWritesRejected(s.current());
    expect(sameVec(s.place(P), before)).toBe(true);
  });

  it('rejects a cast write through current() at depth 0, where it is IDENTITY', () => {
    const s = new TransformStore();
    expectWritesRejected(s.current());
    expect(s.place(P)).toEqual([1, 2, 3]);
    expect(IDENTITY.R).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    expect(IDENTITY.t).toEqual([0, 0, 0]);
  });

  it('rejects a cast write through the exported IDENTITY and through compose()', () => {
    expectWritesRejected(IDENTITY);
    expectWritesRejected(compose(T(rotZ(0.4), [1, 2, 3]), T(rotZ(0.6), [4, 5, 6])));
  });

  it('gives compose() a result that shares no array with either input', () => {
    const a = T(rotZ(0.4), [7, 8, 9]);
    const b = T(rotZ(0.6), [1, 2, 3]);
    const c = compose(a, b);
    expect(c.R as unknown).not.toBe(a.R as unknown);
    expect(c.R as unknown).not.toBe(b.R as unknown);
    expect(c.t as unknown).not.toBe(a.t as unknown);
    expect(c.t as unknown).not.toBe(b.t as unknown);
    for (let i = 0; i < 3; i++) {
      expect(c.R[i] as unknown).not.toBe(a.R[i] as unknown);
      expect(c.R[i] as unknown).not.toBe(b.R[i] as unknown);
    }
  });

  it('does not alias the caller-owned transform passed to apply()', () => {
    const s = new TransformStore();
    const mine = { R: rotZ(0.5) as Mat3, t: [1, 2, 3] as unknown as Vec3 };
    s.apply(mine);
    const before = s.place(P);
    (mine.R as unknown as number[][])[0][0] = 42;
    (mine.t as unknown as number[])[0] = 42;
    expect(sameVec(s.place(P), before)).toBe(true);
  });

  it('returns a place() result the caller owns, detached from the store', () => {
    const s = stacked();
    const out = s.place(P) as unknown as number[];
    const before: Vec3 = [out[0], out[1], out[2]];
    out[0] = 1234;
    expect(sameVec(s.place(P), before)).toBe(true);
  });
});

/**
 * place() reads the current placement through a cache keyed on the top of the
 * stack. Every write path to that top is driven here and observed through
 * place() bitwise, so a cache that failed to refresh would show up as a stale
 * coordinate rather than as a passing test.
 */
describe('place() tracks the top of the stack through apply, undo and reset', () => {
  it('never serves a placement the stack has moved off', () => {
    const s = new TransformStore();
    const P: Vec3 = [1.5, -2.25, 0.75];
    const atIdentity = s.place(P);
    expect(atIdentity).toEqual([1.5, -2.25, 0.75]);
    s.apply(T(rotZ(0.3), [10, 0, 0]));
    const afterA = s.place(P);
    s.apply(T(rotZ(0.7), [0, 5, 0]));
    const afterB = s.place(P);
    expect(afterB.every((v, i) => Object.is(v, afterA[i]))).toBe(false);
    s.undo();
    expect(s.place(P).every((v, i) => Object.is(v, afterA[i]))).toBe(true);
    s.apply(T(rotZ(0.7), [0, 5, 0]));
    expect(s.place(P).every((v, i) => Object.is(v, afterB[i]))).toBe(true);
    s.reset();
    expect(s.place(P).every((v, i) => Object.is(v, atIdentity[i]))).toBe(true);
  });
});
