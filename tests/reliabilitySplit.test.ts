/**
 * reliabilitySplit.test.ts
 *
 * Pins the Wilson interval against known values and confirms measured-cell
 * empirical reliability is reported with a CI while interpolated cells are
 * labelled model-based support with no reliability claim.
 */

import { describe, it, expect } from 'vitest';
import {
  wilsonInterval, empiricalReliability, splitReliability, type ZonedSample,
} from '../src/terrain/validate/reliabilitySplit';

describe('Wilson score interval', () => {
  it('stays inside [0,1] at the p=1 boundary where the normal approx fails', () => {
    // 10/10 within tolerance. Normal approx gives [1,1] (zero width); Wilson
    // gives a sensible upper-bounded interval below 1.
    const { low, high } = wilsonInterval(10, 10);
    expect(high).toBeLessThanOrEqual(1);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(1);
  });

  it('stays inside [0,1] at the p=0 boundary', () => {
    const { low, high } = wilsonInterval(0, 10);
    expect(low).toBe(0);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
  });

  it('brackets a known midpoint proportion', () => {
    // 50/100 → centre ~0.5, roughly ±0.098 (textbook Wilson value).
    const { low, high } = wilsonInterval(50, 100);
    expect(low).toBeGreaterThan(0.40);
    expect(low).toBeLessThan(0.41);
    expect(high).toBeGreaterThan(0.59);
    expect(high).toBeLessThan(0.60);
  });

  it('widens as n shrinks (less data, more uncertainty)', () => {
    const wide = wilsonInterval(5, 10);
    const narrow = wilsonInterval(50, 100);
    expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
  });
});

describe('empirical reliability', () => {
  it('reports fraction within tolerance and a CI that brackets it', () => {
    const errs = [0.01, 0.02, 0.03, 0.2, 0.04, 0.05, 0.5, 0.06]; // 6/8 ≤ 0.1
    const r = empiricalReliability(errs, 0.1);
    expect(r.n).toBe(8);
    expect(r.within).toBe(6);
    expect(r.reliability).toBeCloseTo(0.75, 9);
    expect(r.ciLow).toBeLessThanOrEqual(r.reliability);
    expect(r.ciHigh).toBeGreaterThanOrEqual(r.reliability);
  });

  it('is honest on empty input', () => {
    const r = empiricalReliability([], 0.1);
    expect(r.n).toBe(0);
    expect(Number.isNaN(r.reliability)).toBe(true);
    expect(Number.isNaN(r.ciLow)).toBe(true);
  });
});

describe('measured vs interpolated split', () => {
  it('gives measured cells a reliability and interpolated cells only labelled support', () => {
    const samples: ZonedSample[] = [
      { absError: 0.01, zone: 'measured' },
      { absError: 0.02, zone: 'measured' },
      { absError: 0.5, zone: 'measured' },
      { absError: 0.03, zone: 'interpolated' },
      { absError: 0.9, zone: 'interpolated' },
    ];
    const s = splitReliability(samples, 0.1);
    expect(s.measured.n).toBe(3);
    expect(s.measured.reliability).toBeCloseTo(2 / 3, 9);
    expect(Number.isFinite(s.measured.ciLow)).toBe(true);
    // Interpolated: coverage fraction only, explicitly not calibrated.
    expect(s.interpolated.n).toBe(2);
    expect(s.interpolated.withinFraction).toBeCloseTo(0.5, 9);
    expect(s.interpolated.calibrated).toBe(false);
    expect(s.interpolated.note).toMatch(/not a calibrated reliability/i);
    // The interpolated figure carries no reliability/CI fields to be mistaken
    // for a measured probability.
    expect('reliability' in s.interpolated).toBe(false);
    expect('ciLow' in s.interpolated).toBe(false);
  });
});
