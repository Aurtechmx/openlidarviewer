/**
 * runnerStats.test.ts — the statistics every published summary rests on.
 *
 * The quantile cases are hand-computed against the type-7 definition (R's and
 * NumPy's default) rather than against this implementation's own output, so the
 * test would catch a switch to a different convention — which is the change
 * that would silently move every published IQR.
 */
import { describe, test, expect } from 'vitest';
import {
  QUANTILE_CONVENTION,
  ascending,
  quantileSorted,
  summariesMatch,
  summariseSeries,
} from '../../benchmarks/runner/stats';

describe('quantiles', () => {
  test('names the convention it implements', () => {
    expect(QUANTILE_CONVENTION).toBe('type-7');
  });

  test('type-7 interpolates between order statistics', () => {
    // n = 4, p = 0.25 → h = 0.75 → 1 + 0.75·(2−1) = 1.75. A "nearest rank"
    // convention would answer 1 or 2 here, which is exactly the drift to catch.
    const s = [1, 2, 3, 4];
    expect(quantileSorted(s, 0.25)).toBeCloseTo(1.75, 12);
    expect(quantileSorted(s, 0.5)).toBeCloseTo(2.5, 12);
    expect(quantileSorted(s, 0.75)).toBeCloseTo(3.25, 12);
  });

  test('an odd sample takes the middle value exactly', () => {
    expect(quantileSorted([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  test('the extremes are the extremes', () => {
    expect(quantileSorted([7, 8, 9], 0)).toBe(7);
    expect(quantileSorted([7, 8, 9], 1)).toBe(9);
  });

  test('a single value is its own quantile', () => {
    expect(quantileSorted([42], 0.25)).toBe(42);
  });

  test('refuses an empty sample and an out-of-range p', () => {
    expect(() => quantileSorted([], 0.5)).toThrow(/empty sample/);
    expect(() => quantileSorted([1, 2], 1.5)).toThrow(/p must be in/);
  });

  test('sorts numerically, not lexicographically', () => {
    // The default Array.sort would give [10, 2, 9] and a median of 2.
    expect(ascending([10, 2, 9])).toEqual([2, 9, 10]);
  });
});

describe('series summaries', () => {
  test('median, IQR and CV over a known sample', () => {
    const s = summariseSeries([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.count).toBe(8);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
    expect(s.mean).toBe(5);
    expect(s.median).toBe(4.5);
    // type-7: q1 = 4, q3 = 5.5 → IQR 1.5.
    expect(s.q1).toBeCloseTo(4, 12);
    expect(s.q3).toBeCloseTo(5.5, 12);
    expect(s.iqr).toBeCloseTo(1.5, 12);
    // SAMPLE standard deviation (n − 1): √(32/7). The population figure is 2.
    expect(s.stdDev).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(s.cv).toBeCloseTo(Math.sqrt(32 / 7) / 5, 12);
  });

  test('keeps the raw values in run order, never sorted', () => {
    expect(summariseSeries([3, 1, 2]).values).toEqual([3, 1, 2]);
  });

  test('a single run has no dispersion, and says so instead of reporting 0', () => {
    const s = summariseSeries([5]);
    expect(s.stdDev).toBeNull();
    expect(s.cv).toBeNull();
    expect(s.unavailable.stdDev).toMatch(/at least two runs/);
    expect(s.unavailable.cv).toMatch(/standard deviation/);
  });

  test('a zero mean leaves the CV undefined rather than infinite', () => {
    const s = summariseSeries([-1, 1]);
    expect(s.stdDev).not.toBeNull();
    expect(s.cv).toBeNull();
    expect(s.unavailable.cv).toMatch(/zero mean/);
  });

  test('refuses a non-finite value rather than summarising the rest', () => {
    expect(() => summariseSeries([1, Number.NaN, 3])).toThrow(/not finite/);
    expect(() => summariseSeries([1, Infinity])).toThrow(/not finite/);
    expect(() => summariseSeries([])).toThrow(/empty sample/);
  });
});

describe('summary comparison', () => {
  test('identical samples match, a single changed value does not', () => {
    const a = summariseSeries([1, 2, 3]);
    expect(summariesMatch(a, summariseSeries([1, 2, 3]))).toBe(true);
    expect(summariesMatch(a, summariseSeries([1, 2, 4]))).toBe(false);
    // Same statistics, different raw values would be a doctored summary.
    expect(summariesMatch(a, summariseSeries([3, 2, 1]))).toBe(false);
  });
});
