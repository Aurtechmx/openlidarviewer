/**
 * terrainMetrics.test.ts — the shared validation comparators.
 */

import { describe, it, expect } from 'vitest';
import { gridErrorStats, circularAspectError, aspectErrorStats } from '../src/validation/terrainMetrics';

describe('gridErrorStats', () => {
  it('computes MAE, RMSE, median, signed bias and max over paired cells', () => {
    // ours − ref = [+0.1, +0.1, +0.1, +0.1] → bias +0.1, all errors 0.1.
    const s = gridErrorStats([1.1, 2.1, 3.1, 4.1], [1, 2, 3, 4]);
    expect(s.n).toBe(4);
    expect(s.mae).toBeCloseTo(0.1, 9);
    expect(s.rmse).toBeCloseTo(0.1, 9);
    expect(s.medianAbsError).toBeCloseTo(0.1, 9);
    expect(s.signedBias).toBeCloseTo(0.1, 9);
    expect(s.maxAbsError).toBeCloseTo(0.1, 9);
  });

  it('separates a systematic bias from spread', () => {
    // A constant +0.5 offset: bias 0.5, and mae 0.5, rmse 0.5 (no spread).
    const s = gridErrorStats([5.5, 6.5, 7.5], [5, 6, 7]);
    expect(s.signedBias).toBeCloseTo(0.5, 9);
    // A symmetric ±0.5: bias ~0 but mae 0.5.
    const t = gridErrorStats([5.5, 5.5], [5, 6]);
    expect(t.signedBias).toBeCloseTo(0, 9);
    expect(t.mae).toBeCloseTo(0.5, 9);
  });

  it('the median resists a single large outlier the RMSE does not', () => {
    const s = gridErrorStats([1, 1, 1, 1, 100], [1, 1, 1, 1, 1]);
    expect(s.medianAbsError).toBe(0); // 4 zeros, one 99 → median 0
    expect(s.maxAbsError).toBe(99);
    expect(s.rmse).toBeGreaterThan(40); // the outlier dominates RMSE
  });

  it('excludes NaN and the nodata sentinel, and reports coverage', () => {
    // ref has 4 valued cells; ours matches 3 (one NaN) → coverage 3/4.
    const s = gridErrorStats([1, NaN, 3, 4], [1, 2, 3, 4], { nodata: -9999 });
    expect(s.n).toBe(3);
    expect(s.coverage).toBeCloseTo(0.75, 9);
    expect(s.rejectionFraction).toBeCloseTo(0.25, 9);
  });

  it('does not count a reference nodata cell against coverage', () => {
    const s = gridErrorStats([1, 2, 3], [1, -9999, 3], { nodata: -9999 });
    expect(s.n).toBe(2); // only the 2 valued ref cells
    expect(s.coverage).toBe(1); // both reference-valued cells were covered
  });
});

describe('circularAspectError', () => {
  it('reads 359 and 1 as 2 apart, never 358', () => {
    expect(circularAspectError(359, 1)).toBeCloseTo(2, 9);
    expect(circularAspectError(1, 359)).toBeCloseTo(2, 9);
  });
  it('caps at 180 (opposite bearings)', () => {
    expect(circularAspectError(0, 180)).toBeCloseTo(180, 9);
    expect(circularAspectError(90, 270)).toBeCloseTo(180, 9);
  });
  it('is a plain difference away from the wrap', () => {
    expect(circularAspectError(10, 40)).toBeCloseTo(30, 9);
  });
  it('normalises out-of-range and negative bearings', () => {
    expect(circularAspectError(-1, 1)).toBeCloseTo(2, 9);
    expect(circularAspectError(361, 1)).toBeCloseTo(0, 9);
  });
  it('drives aspectErrorStats so a wrap pair reads small, not huge', () => {
    const s = aspectErrorStats([359, 10], [1, 40]);
    expect(s.maxAbsError).toBeCloseTo(30, 9); // the 10↔40 pair, not 358
  });
});
