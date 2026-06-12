/**
 * calibrateConfidence.test.ts — fit + apply confidence calibration.
 */

import { describe, it, expect } from 'vitest';
import {
  fitConfidenceCalibration,
  applyConfidenceCalibration,
} from '../src/terrain/validate/calibrateConfidence';
import type { ConfidenceSample } from '../src/terrain/validate/ValidationReport';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

/** Build a sample set where reliability tracks confidence. */
function samples(): ConfidenceSample[] {
  const out: ConfidenceSample[] = [];
  // High-confidence cells: mostly within tolerance (1 m). Low-confidence:
  // mostly outside. 100 samples total.
  for (let i = 0; i < 50; i++) out.push({ confidence: 90, absError: i < 45 ? 0.3 : 3 }); // 90% reliable
  for (let i = 0; i < 50; i++) out.push({ confidence: 20, absError: i < 10 ? 0.3 : 3 }); // 20% reliable
  return out;
}

describe('fitConfidenceCalibration', () => {
  it('maps raw confidence toward measured reliability', () => {
    const cal = fitConfidenceCalibration(samples(), { toleranceM: 1 });
    expect(cal.assessable).toBe(true);
    // The 90-confidence band was ~90% reliable; the 20-band ~20%.
    expect(cal.remap(90)).toBeGreaterThan(70);
    expect(cal.remap(20)).toBeLessThan(40);
    // Monotonic non-decreasing.
    expect(cal.remap(90)).toBeGreaterThanOrEqual(cal.remap(20));
  });

  it('is not assessable with too few samples (no fabrication from noise)', () => {
    const cal = fitConfidenceCalibration(
      [{ confidence: 80, absError: 0.1 }],
      { toleranceM: 1 },
    );
    expect(cal.assessable).toBe(false);
    expect(cal.remap(80)).toBe(80); // identity
  });

  it('is not assessable without a usable tolerance', () => {
    const cal = fitConfidenceCalibration(samples(), { toleranceM: null });
    expect(cal.assessable).toBe(false);
  });

  it('floors a tiny tolerance so a near-perfect surface stays reliable', () => {
    // Near-perfect data: every held-out error is 1 mm, but the measured
    // RMSE is an absurdly tiny 1e-8 m. Without a noise floor every error
    // would exceed τ and reliability would collapse to 0%. The 1 cm floor
    // must keep such a surface highly reliable instead.
    const s: ConfidenceSample[] = [];
    for (let i = 0; i < 80; i++) s.push({ confidence: 50 + (i % 40), absError: 0.001 });
    const cal = fitConfidenceCalibration(s, { toleranceM: 1e-8 });
    expect(cal.assessable).toBe(true);
    expect(cal.toleranceM).toBeCloseTo(0.01, 6); // floored to 1 cm
    expect(cal.remap(60)).toBeGreaterThan(90); // reliable, not collapsed to 0
  });

  it('a near-empty noisy bin cannot bend the curve (min bin occupancy)', () => {
    // 96 well-behaved samples at confidence ~45 (≈81% reliable) plus TWO
    // stray samples at confidence 25, one of which misses tolerance — a
    // 50% "reliability" measured from a coin flip. Because the remap is
    // flat-extrapolated past the end knots, that 2-sample bin used to set
    // the calibrated value for EVERY raw confidence ≤ 25 (and to drag the
    // 25–45 interpolation down with it). Bins under the occupancy floor
    // (default 5) are now excluded, so low raw confidences inherit the
    // first REAL knot instead.
    const s: ConfidenceSample[] = [];
    for (let i = 0; i < 96; i++) s.push({ confidence: 45, absError: i < 78 ? 0.1 : 3 });
    for (let i = 0; i < 40; i++) s.push({ confidence: 85, absError: i < 38 ? 0.1 : 3 });
    s.push({ confidence: 25, absError: 0.1 });
    s.push({ confidence: 25, absError: 3 });
    const cal = fitConfidenceCalibration(s, { toleranceM: 1, bins: 10 });
    expect(cal.assessable).toBe(true);
    // No knot from the 2-sample bin: nothing maps to its 50% coin flip.
    expect(cal.curve.every((k) => k.count >= 5)).toBe(true);
    expect(cal.remap(25)).toBeGreaterThan(70); // ≈ the measured 81%, not 50%
    // An explicit lower floor re-admits the bin (the knob is honoured).
    const loose = fitConfidenceCalibration(s, { toleranceM: 1, bins: 10, minBinCount: 1 });
    expect(loose.remap(25)).toBeLessThan(70);
  });

  it('enforces monotonicity even when raw reliability is non-monotone', () => {
    // Mid band MORE reliable than the high band → PAV must pool them so
    // the curve never decreases.
    const s: ConfidenceSample[] = [];
    for (let i = 0; i < 40; i++) s.push({ confidence: 30, absError: i < 4 ? 0.1 : 3 }); // 10%
    for (let i = 0; i < 40; i++) s.push({ confidence: 60, absError: i < 38 ? 0.1 : 3 }); // 95%
    for (let i = 0; i < 40; i++) s.push({ confidence: 90, absError: i < 20 ? 0.1 : 3 }); // 50%
    const cal = fitConfidenceCalibration(s, { toleranceM: 1, bins: 10 });
    expect(cal.remap(30)).toBeLessThanOrEqual(cal.remap(60) + 1e-6);
    expect(cal.remap(60)).toBeLessThanOrEqual(cal.remap(90) + 1e-6);
  });
});

describe('applyConfidenceCalibration', () => {
  function grid(conf: number[], cov: number[]): DtmGrid {
    const n = conf.length;
    return {
      z: Float32Array.from(conf.map(() => 5)),
      confidence: Float32Array.from(conf),
      coverage: Uint8Array.from(cov),
      counts: Uint32Array.from(conf.map(() => 1)),
      interpDistanceCells: new Float32Array(n),
      cols: n,
      rows: 1,
      cellSizeM: 1,
      originH1: 0,
      originH2: 0,
      crs: 'EPSG:32610',
      verticalDatum: null,
      coverageMode: 'full',
      sourcePointCount: n,
      analyzedPointCount: n,
      meanConfidence: conf.reduce((a, b) => a + b, 0) / n,
      warnings: [],
    };
  }

  it('remaps covered confidence and recomputes the mean', () => {
    const cal = fitConfidenceCalibration(samples(), { toleranceM: 1 });
    const g = applyConfidenceCalibration(grid([90, 20], [2, 2]), cal);
    expect(g.confidence[0]).toBeGreaterThan(g.confidence[1]);
    expect(g.warnings.some((w) => /calibrated/i.test(w))).toBe(true);
  });

  it('returns the grid untouched when calibration is not assessable', () => {
    const cal = fitConfidenceCalibration([], { toleranceM: null });
    const g0 = grid([90, 20], [2, 2]);
    const g1 = applyConfidenceCalibration(g0, cal);
    expect(g1).toBe(g0);
  });
});
