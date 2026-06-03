/**
 * verticalAccuracy.test.ts — ASPRS NVA/VVA derivation + honest formatting.
 */

import { describe, it, expect } from 'vitest';
import {
  computeVerticalAccuracy,
  formatVerticalAccuracy,
  NVA_95_MULTIPLIER,
} from '../src/terrain/validate/verticalAccuracy';
import type { ValidationReport } from '../src/terrain/validate/ValidationReport';

function report(rmse: number, p95: number, sampleSize = 100): ValidationReport {
  return {
    rmse,
    mae: rmse * 0.8,
    p95,
    sampleSize,
    uncoveredCount: 0,
    holdoutFraction: 0.2,
    perBand: [],
    method: 'holdout-cross-validation',
    coverageMode: 'full',
    warnings: [],
  };
}

describe('computeVerticalAccuracy', () => {
  it('derives NVA = 1.96 × RMSE and VVA = p95', () => {
    const a = computeVerticalAccuracy(report(0.5, 1.1));
    expect(a.rmseZ).toBe(0.5);
    expect(a.nva95).toBeCloseTo(0.5 * NVA_95_MULTIPLIER, 6);
    expect(a.vva95).toBe(1.1);
    expect(a.standard).toBe('ASPRS 2014');
  });

  it('reports NaN figures when RMSE is not measurable', () => {
    const a = computeVerticalAccuracy(report(Number.NaN, Number.NaN, 0));
    expect(Number.isNaN(a.nva95)).toBe(true);
  });
});

describe('formatVerticalAccuracy', () => {
  it('states the normal-distribution assumption and both figures', () => {
    const lines = formatVerticalAccuracy(report(0.5, 1.1));
    expect(lines.join(' ')).toMatch(/NVA @ 95%/);
    expect(lines.join(' ')).toMatch(/assumes normally distributed/i);
    expect(lines.join(' ')).toMatch(/VVA @ 95%/);
  });

  it('returns a single honest line when there is no measurement', () => {
    const lines = formatVerticalAccuracy(report(Number.NaN, Number.NaN, 0));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/not enough ground points/i);
  });
});
