/**
 * quantile.test.ts — the project-wide type-7 percentile helper. Every value
 * below is hand-computed: rank = p·(n−1), linear interpolation between the
 * bracketing order statistics (NumPy / R / Excel PERCENTILE.INC).
 */

import { describe, it, expect } from 'vitest';
import { quantile, quantileSorted } from '../src/terrain/quantile';

describe('quantileSorted (type-7)', () => {
  it('p95 of [1,2,3,4]: rank 0.95·3 = 2.85 → 3·0.15 + 4·0.85 = 3.85', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 12);
  });

  it('median of an even list interpolates: [1,2,3,4] → 2.5', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12);
  });

  it('p0 is the minimum, p1 the maximum (out-of-range p clamps)', () => {
    expect(quantileSorted([3, 7, 9], 0)).toBe(3);
    expect(quantileSorted([3, 7, 9], 1)).toBe(9);
    expect(quantileSorted([3, 7, 9], -1)).toBe(3);
    expect(quantileSorted([3, 7, 9], 2)).toBe(9);
  });

  it('single element and empty input', () => {
    expect(quantileSorted([42], 0.77)).toBe(42);
    expect(Number.isNaN(quantileSorted([], 0.5))).toBe(true);
  });

  it('DISAGREES with nearest-rank exactly where the audit predicted', () => {
    // Nearest-rank p95 of 10 elements [1..10]: ceil(0.95·10)−1 = 9 → 10.
    // Type-7: rank 0.95·9 = 8.55 → 9·0.45 + 10·0.55 = 9.55.
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantileSorted(v, 0.95)).toBeCloseTo(9.55, 12);
  });
});

describe('quantile (unsorted, finite-filtered)', () => {
  it('sorts a copy and matches quantileSorted', () => {
    const v = [9, 1, 4, 7];
    expect(quantile(v, 0.5)).toBeCloseTo(quantileSorted([1, 4, 7, 9], 0.5), 12);
    expect(v).toEqual([9, 1, 4, 7]); // input untouched
  });

  it('ignores NaN/±Infinity and returns NaN only when nothing finite survives', () => {
    expect(quantile([Number.NaN, 3, Infinity, 1, 2], 0.5)).toBe(2);
    expect(Number.isNaN(quantile([Number.NaN, Infinity], 0.5))).toBe(true);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

// Mutation-testing follow-up: the p-clamp boundaries survived mutation because
// nothing pinned an OUT-OF-RANGE p. `p < 0 ? 0 : p > 1 ? 1 : p` must clamp, so
// a negative p reads the minimum and a p above 1 reads the maximum rather than
// indexing past the array (NaN) or extrapolating.
describe('quantileSorted — p clamping at and beyond the boundaries', () => {
  const S = [10, 20, 30, 40];
  it('clamps a negative p to the minimum', () => {
    expect(quantileSorted(S, -0.5)).toBe(10);
    expect(quantileSorted(S, -1e9)).toBe(10);
  });
  it('clamps a p above 1 to the maximum', () => {
    expect(quantileSorted(S, 1.5)).toBe(40);
    expect(quantileSorted(S, 1e9)).toBe(40);
  });
  it('p exactly 0 and exactly 1 hit the endpoints, not an interpolation', () => {
    expect(quantileSorted(S, 0)).toBe(10);
    expect(quantileSorted(S, 1)).toBe(40);
  });
  it('a single-element input returns that element for any p', () => {
    expect(quantileSorted([42], 0)).toBe(42);
    expect(quantileSorted([42], 0.5)).toBe(42);
    expect(quantileSorted([42], 1)).toBe(42);
  });
  it('an empty input is NaN, never 0', () => {
    expect(Number.isNaN(quantileSorted([], 0.5))).toBe(true);
  });
});
