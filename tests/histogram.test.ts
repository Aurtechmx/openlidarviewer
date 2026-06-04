import { describe, it, expect } from 'vitest';
import { histogramBins } from '../src/terrain/contour/histogram';

describe('histogramBins', () => {
  it('bins values into equal-width buckets with the max in the last bin', () => {
    const h = histogramBins([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10);
    expect(h.counts).toHaveLength(10);
    expect(h.min).toBe(0);
    expect(h.max).toBe(10);
    expect(h.binWidth).toBeCloseTo(1, 6);
    expect(h.total).toBe(11);
    // Sum of counts equals total (no value lost).
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(11);
    // The max value (10) closes the last bin rather than overflowing.
    expect(h.counts[9]).toBeGreaterThanOrEqual(1);
  });

  it('skips non-finite values', () => {
    const h = histogramBins([1, NaN, 2, Infinity, 3, -Infinity], 3);
    expect(h.total).toBe(3);
    expect(h.min).toBe(1);
    expect(h.max).toBe(3);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('handles an all-equal spread without dividing by zero', () => {
    const h = histogramBins([5, 5, 5, 5], 8);
    expect(h.total).toBe(4);
    expect(h.binWidth).toBe(0);
    expect(h.counts[0]).toBe(4);
    expect(h.peak).toBe(4);
  });

  it('returns NaN bounds and zero peak for an empty input', () => {
    const h = histogramBins([], 5);
    expect(h.total).toBe(0);
    expect(Number.isNaN(h.min)).toBe(true);
    expect(Number.isNaN(h.max)).toBe(true);
    expect(h.peak).toBe(0);
  });

  it('reports the tallest bin as peak', () => {
    // Cluster most values into the low end.
    const h = histogramBins([0, 0, 0, 0, 0, 10], 2);
    expect(h.counts[0]).toBe(5);
    expect(h.counts[1]).toBe(1);
    expect(h.peak).toBe(5);
  });
});
