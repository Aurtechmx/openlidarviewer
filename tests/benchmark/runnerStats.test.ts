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
  checkFirstRun,
  firstSummaryDifference,
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

  test('names the field that differs, not always the median', () => {
    const published = summariseSeries([10, 20, 30]);
    // A summary whose `min` was edited: the median is untouched, so a message
    // that always names the median prints two identical numbers and reads as a
    // broken verifier rather than as a caught tamper.
    const doctored = { ...published, min: 1 };
    const diff = firstSummaryDifference(doctored, published);
    expect(diff).toEqual({ key: 'min', published: 1, recomputed: 10 });
  });

  test('reports a changed raw value by index', () => {
    const a = summariseSeries([1, 2, 3]);
    const b = { ...a, values: [1, 9, 3] };
    expect(firstSummaryDifference(b, a)).toEqual({ key: 'values[1]', published: 9, recomputed: 2 });
  });

  test('reports null for identical summaries', () => {
    expect(firstSummaryDifference(summariseSeries([1, 2]), summariseSeries([1, 2]))).toBeNull();
  });
});

describe('the first-run warm-up check', () => {
  /** A steady series: run 1 sits with the rest. */
  const steady = [100, 101, 99, 100.5, 99.5, 100.2, 99.8, 100.1, 99.9, 100.3];

  test('passes a steady series', () => {
    const check = checkFirstRun(steady);
    expect(check?.withinRobustBand).toBe(true);
  });

  test('catches the transient that actually occurred: run 1 about 11 % slow', () => {
    const check = checkFirstRun([111, ...steady.slice(1)]);
    expect(check?.withinRobustBand).toBe(false);
    expect(check?.ratioToRestMedian).toBeGreaterThan(1.1);
  });

  test('does NOT gate on the rest\'s min-max range, which a healthy run fails 2/n of the time', () => {
    // Run 1 is the largest value here — outside [min, max] of the rest — but
    // only 0.4 % above their median. Gating on range membership would fail this.
    const check = checkFirstRun([101.5, ...steady.slice(1)]);
    expect(check?.withinRestRange).toBe(false);
    expect(check?.withinRobustBand).toBe(true);
  });

  test('does NOT gate on interquartile membership, which is a coin flip', () => {
    const check = checkFirstRun([99.6, ...steady.slice(1)]);
    expect(check?.withinRestIqr).toBe(false);
    expect(check?.withinRobustBand).toBe(true);
  });

  test('the fractional floor keeps a near-zero IQR from making every run anomalous', () => {
    // Eight identical values: IQR is 0, so a pure 3-IQR band would be a point
    // and any difference at all would fail.
    const check = checkFirstRun([100.5, 100, 100, 100, 100, 100, 100, 100, 100]);
    expect(check?.restIqr).toBe(0);
    expect(check?.bandHalfWidth).toBeCloseTo(5, 12);
    expect(check?.withinRobustBand).toBe(true);
    // A materially different first run still fails, floor or no floor.
    expect(checkFirstRun([120, 100, 100, 100, 100, 100, 100, 100, 100])?.withinRobustBand).toBe(false);
  });

  test('needs at least three runs to say anything', () => {
    expect(checkFirstRun([1, 2])).toBeNull();
    expect(checkFirstRun([1, 2, 3])).not.toBeNull();
  });

  test('withholds the band on a sample too small to estimate a spread', () => {
    // Four comparison runs: the band's width would come from a four-point IQR,
    // where one GC pause is indistinguishable from a warm-up transient. Null,
    // with a reason — not a verdict computed from too little.
    const small = checkFirstRun([200, 100, 100, 101, 99]);
    expect(small?.withinRobustBand).toBeNull();
    expect(small?.bandHalfWidth).toBeNull();
    expect(small?.bandUnavailableReason).toMatch(/comparison runs/);

    const enough = checkFirstRun([200, 100, 100, 101, 99, 100]);
    expect(enough?.withinRobustBand).toBe(false);
  });

  test('publishes the dispersion with and without run 1, so the contamination is visible', () => {
    // A steady series with one cold start. The CV including run 1 is several
    // times the CV without it, and that gap is the whole finding.
    const check = checkFirstRun([111, ...steady.slice(1)]);
    expect(check?.cvAllRuns).not.toBeNull();
    expect(check?.cvExcludingFirstRun).not.toBeNull();
    expect(check?.cvAllRuns as number).toBeGreaterThan((check?.cvExcludingFirstRun as number) * 2);
    // On a clean series the two are close, so the pair is not alarming by
    // construction — it only separates when there is something to see.
    const clean = checkFirstRun(steady);
    expect(clean?.cvAllRuns as number).toBeLessThan((clean?.cvExcludingFirstRun as number) * 2);
  });
});
