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

function report(
  rmse: number,
  p95: number,
  sampleSize = 100,
  bias = 0,
  nmad = Number.NaN,
): ValidationReport {
  return {
    rmse,
    mae: rmse * 0.8,
    p95,
    bias,
    nmad,
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

  it('carries signed bias + NMAD through, and formats them with direction', () => {
    const a = computeVerticalAccuracy(report(0.5, 1.1, 100, -0.08, 0.3));
    expect(a.bias).toBe(-0.08);
    expect(a.nmad).toBe(0.3);
    const lines = formatVerticalAccuracy(report(0.5, 1.1, 100, -0.08, 0.3)).join('\n');
    // Negative bias ⇒ surface reads high; NMAD line present.
    expect(lines).toMatch(/Systematic bias: -0\.08 m.*reads high/);
    expect(lines).toMatch(/NMAD \(robust spread, hold-out\): 0\.30 m/);
  });

  it('reports NaN figures when RMSE is not measurable', () => {
    const a = computeVerticalAccuracy(report(Number.NaN, Number.NaN, 0));
    expect(Number.isNaN(a.nva95)).toBe(true);
  });
});

describe('formatVerticalAccuracy', () => {
  it('states the normal-distribution assumption and both figures', () => {
    const lines = formatVerticalAccuracy(report(0.5, 1.1));
    expect(lines.join(' ')).toMatch(/NVA-style @ 95%/);
    expect(lines.join(' ')).toMatch(/assumes normally distributed/i);
    expect(lines.join(' ')).toMatch(/VVA-style @ 95%/);
  });

  it('qualifies every figure as hold-out — never an independent-checkpoint claim', () => {
    const lines = formatVerticalAccuracy(report(0.5, 1.1));
    // All three lines carry the hold-out qualifier.
    for (const line of lines) expect(line).toMatch(/hold-out/);
    // The disclosures name what the figures are NOT.
    expect(lines.join(' ')).toMatch(/not independent checkpoints/i);
    expect(lines.join(' ')).toMatch(/not vegetated-class checkpoints/i);
  });

  it('returns a single honest line when there is no measurement', () => {
    const lines = formatVerticalAccuracy(report(Number.NaN, Number.NaN, 0));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/not enough ground points/i);
  });
});
