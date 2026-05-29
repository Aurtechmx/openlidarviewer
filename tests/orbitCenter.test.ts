/**
 * orbitCenter.test.ts
 *
 * Pure-helper tests behind the volumetric-orbit fix. Verifies:
 *   • `aabbCenter` returns the component-wise mid-point.
 *   • `aabbDiagonal` is the AABB's Euclidean diagonal.
 *   • `clampTargetToExpandedAabb` clamps inside the inflated envelope, lets
 *     in-bounds targets pass through, expands by the right fraction, returns
 *     a fresh tuple (no aliasing), and survives degenerate / NaN inputs.
 *   • `lerpTowardCenter` interpolates linearly and clamps `t ∈ [0, 1]`.
 *   • `distance` matches the Euclidean norm.
 *
 * These tests are pure-JS, run in Node under Vitest — no Viewer instance, no
 * three.js, no WebGPU. They guarantee the Viewer's camera-centering code uses
 * a numerically-correct primitive set.
 */

import { describe, it, expect } from 'vitest';
import {
  aabbCenter,
  aabbDiagonal,
  clampTargetToExpandedAabb,
  lerpTowardCenter,
  distance,
  type Aabb,
} from '../src/render/orbitCenter';

const AUTZEN_AABB: Aabb = [637000, 851000, 100, 638200, 853000, 220];

describe('aabbCenter', () => {
  it('returns the component-wise mid-point of an AABB', () => {
    const c = aabbCenter([0, 0, 0, 10, 20, 30]);
    expect(c).toEqual([5, 10, 15]);
  });

  it('handles large translated coordinates (UTM-scale LAS surveys)', () => {
    const c = aabbCenter(AUTZEN_AABB);
    expect(c[0]).toBeCloseTo(637600, 6);
    expect(c[1]).toBeCloseTo(852000, 6);
    expect(c[2]).toBeCloseTo(160, 6);
  });

  it('handles zero-extent boxes (single point)', () => {
    expect(aabbCenter([5, 5, 5, 5, 5, 5])).toEqual([5, 5, 5]);
  });
});

describe('aabbDiagonal', () => {
  it('matches the Euclidean diagonal of the AABB', () => {
    expect(aabbDiagonal([0, 0, 0, 3, 4, 0])).toBeCloseTo(5, 9);
    expect(aabbDiagonal([0, 0, 0, 1, 1, 1])).toBeCloseTo(Math.sqrt(3), 9);
  });

  it('is zero for a point AABB', () => {
    expect(aabbDiagonal([7, 7, 7, 7, 7, 7])).toBe(0);
  });
});

describe('clampTargetToExpandedAabb', () => {
  const box: Aabb = [0, 0, 0, 10, 10, 10];

  it('passes targets that are already inside the expanded envelope', () => {
    const t = clampTargetToExpandedAabb([5, 5, 5], box);
    expect(t).toEqual([5, 5, 5]);
  });

  it('clamps targets that lie outside the inflated envelope', () => {
    // Diagonal = sqrt(300) ≈ 17.32; 25% pad ≈ 4.33; envelope is roughly
    // [-4.33, -4.33, -4.33, 14.33, 14.33, 14.33].
    const t = clampTargetToExpandedAabb([100, -100, 50], box);
    expect(t[0]).toBeLessThanOrEqual(14.34);
    expect(t[0]).toBeGreaterThan(13);
    expect(t[1]).toBeGreaterThanOrEqual(-4.34);
    expect(t[1]).toBeLessThan(-4);
    expect(t[2]).toBeLessThanOrEqual(14.34);
  });

  it('honours a custom expand fraction', () => {
    // expandFraction = 0 means the envelope is exactly the AABB.
    const t = clampTargetToExpandedAabb([12, 5, 5], box, 0);
    expect(t).toEqual([10, 5, 5]);
  });

  it('returns a fresh tuple — never aliases the input', () => {
    const input: [number, number, number] = [5, 5, 5];
    const t = clampTargetToExpandedAabb(input, box);
    expect(t).not.toBe(input);
  });

  it('passes through targets when the AABB is degenerate (zero diagonal)', () => {
    const t = clampTargetToExpandedAabb([99, 99, 99], [0, 0, 0, 0, 0, 0]);
    expect(t).toEqual([99, 99, 99]);
  });

  it('passes through NaN target components untouched (defensive)', () => {
    const t = clampTargetToExpandedAabb([Number.NaN, 5, 5], box);
    expect(Number.isNaN(t[0])).toBe(true);
    expect(t[1]).toBe(5);
    expect(t[2]).toBe(5);
  });
});

describe('lerpTowardCenter', () => {
  it('returns the start when t = 0', () => {
    expect(lerpTowardCenter([0, 0, 0], [10, 10, 10], 0)).toEqual([0, 0, 0]);
  });

  it('returns the end when t = 1', () => {
    expect(lerpTowardCenter([0, 0, 0], [10, 10, 10], 1)).toEqual([10, 10, 10]);
  });

  it('interpolates linearly at t = 0.5', () => {
    const v = lerpTowardCenter([0, 0, 0], [10, 20, 40], 0.5);
    expect(v).toEqual([5, 10, 20]);
  });

  it('clamps t below 0 and above 1', () => {
    expect(lerpTowardCenter([0, 0, 0], [10, 10, 10], -0.5)).toEqual([0, 0, 0]);
    expect(lerpTowardCenter([0, 0, 0], [10, 10, 10], 1.5)).toEqual([10, 10, 10]);
  });

  it('approaches but never overshoots the target with the 0.05 streaming factor', () => {
    // Streaming refinement uses t=0.05 every frame. After ~60 frames the
    // residual error should be < 5% of the original.
    let v: readonly [number, number, number] = [0, 0, 0];
    const target: readonly [number, number, number] = [100, 0, 0];
    for (let i = 0; i < 60; i++) v = lerpTowardCenter(v, target, 0.05) as typeof v;
    expect(target[0] - v[0]).toBeGreaterThan(0);   // never overshoot
    expect(target[0] - v[0]).toBeLessThan(5);      // converged within 5%
  });
});

describe('distance', () => {
  it('matches the Euclidean norm', () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBeCloseTo(5, 9);
    expect(distance([1, 1, 1], [1, 1, 1])).toBe(0);
  });
});
