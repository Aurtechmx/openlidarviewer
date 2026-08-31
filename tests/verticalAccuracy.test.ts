/**
 * verticalAccuracy.test.ts — ASPRS NVA/VVA derivation + honest formatting.
 */

import { describe, it, expect } from 'vitest';
import {
  computeVerticalAccuracy,
  formatVerticalAccuracy,
  NVA_95_MULTIPLIER,
  ASPRS_2024_UNAVAILABLE_NOTE,
  LEGACY_ASPRS_2014_BASIS,
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
    estimand: 'point-reconstruction',
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
    expect(a.standard).toBe('legacy ASPRS 2014 formulas, hold-out basis');
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
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/not enough ground points/i);
  });
});

describe('VerticalAccuracy.standard — a basis tag, not a conformance tag', () => {
  it('never reads as a bare "ASPRS 2014" conformance claim', () => {
    const a = computeVerticalAccuracy(report(0.5, 1.1));
    expect(a.standard).not.toBe('ASPRS 2014');
    expect(a.standard).toMatch(/formulas/i);
    expect(a.standard).toMatch(/hold-out/i);
  });
});

describe('current-standard boundary', () => {
  it('names the 2014 figures as a LEGACY diagnostic, never the current standard', () => {
    expect(LEGACY_ASPRS_2014_BASIS).toMatch(/legacy/i);
    expect(LEGACY_ASPRS_2014_BASIS).toMatch(/2014/);
    expect(LEGACY_ASPRS_2014_BASIS).toMatch(/hold-out/i);
  });

  it('states the ASPRS 2024 assessment is unavailable and why', () => {
    expect(ASPRS_2024_UNAVAILABLE_NOTE).toMatch(/ASPRS 2024|Edition 2/);
    expect(ASPRS_2024_UNAVAILABLE_NOTE).toMatch(/unavailable/i);
    expect(ASPRS_2024_UNAVAILABLE_NOTE).toMatch(/independent checkpoint/i);
    // RMSEV is the current positional-accuracy measure; the note must name it.
    expect(ASPRS_2024_UNAVAILABLE_NOTE).toMatch(/RMSEV/);
  });

  it('never claims the 2014 form is current or that NVA-95 is the current measure', () => {
    // Guards against a regression that re-asserts the outdated vocabulary as current.
    for (const s of [LEGACY_ASPRS_2014_BASIS, ASPRS_2024_UNAVAILABLE_NOTE]) {
      expect(s).not.toMatch(/ASPRS 2014 is current/i);
      expect(s).not.toMatch(/current positional accuracy/i);
    }
  });
});
