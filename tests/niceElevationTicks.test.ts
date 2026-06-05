import { describe, it, expect } from 'vitest';
import { niceElevationTicks } from '../src/ui/MeasurePanel';

/**
 * tests/niceElevationTicks.test.ts
 *
 * The profile chart's elevation axis labels itself with rounded "nice"
 * tick values (survey/engineering convention) instead of the raw data
 * min/max. These specs pin the contract that downstream label formatting
 * relies on: ticks are on a 1/2/5×10ⁿ grid, lie inside the band, and the
 * helper degrades gracefully on a flat or invalid band.
 */
describe('niceElevationTicks', () => {
  it('produces rounded ticks on a 1/2/5×10ⁿ grid inside the band', () => {
    const ticks = niceElevationTicks(100, 130, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(100);
      expect(t).toBeLessThanOrEqual(130);
    }
    // 30 m over ~4 ticks → a 10 m step.
    expect(ticks).toEqual([100, 110, 120, 130]);
  });

  it('handles sub-metre bands with a fractional nice step', () => {
    const ticks = niceElevationTicks(0, 0.4, 4);
    expect(ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
  });

  it('keeps a consistent step (no floating-point dust)', () => {
    const ticks = niceElevationTicks(12.3, 47.8, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    const step = ticks[1] - ticks[0];
    for (let i = 2; i < ticks.length; i++) {
      expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 9);
    }
    // The step is a nice unit (10 here) — no 9.9999 / 0.0001 dust.
    expect(step).toBe(10);
  });

  it('degrades gracefully on a flat or invalid band', () => {
    expect(niceElevationTicks(50, 50)).toEqual([50]);
    expect(niceElevationTicks(Number.NaN, 10)).toEqual([]);
    expect(niceElevationTicks(10, 5)).toEqual([10]);
  });
});
