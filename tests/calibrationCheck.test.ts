/**
 * calibrationCheck.test.ts — specs. The calibration check is
 * the guard that keeps confidence honest, so these specs pin both the
 * pass and fail directions plus the not-assessable case.
 */

import { describe, it, expect } from 'vitest';
import { checkCalibration } from '../src/terrain/validate/calibrationCheck';
import type { BandError, ValidationReport } from '../src/terrain/validate/ValidationReport';

function report(bands: Partial<Record<BandError['grade'], { rmse: number; count: number }>>): ValidationReport {
  const perBand: BandError[] = (['solid', 'dashed', 'gap'] as const).map((grade) => {
    const b = bands[grade];
    return {
      grade,
      count: b?.count ?? 0,
      rmse: b ? b.rmse : Number.NaN,
      mae: b ? b.rmse : Number.NaN,
    };
  });
  return {
    rmse: 0,
    mae: 0,
    p95: 0,
    sampleSize: perBand.reduce((a, b) => a + b.count, 0),
    uncoveredCount: 0,
    holdoutFraction: 0.2,
    perBand,
    method: 'holdout-cross-validation',
    coverageMode: 'full',
    warnings: [],
  };
}

describe('checkCalibration', () => {
  it('passes when error rises as confidence falls', () => {
    const r = report({
      solid: { rmse: 0.1, count: 10 },
      dashed: { rmse: 0.3, count: 10 },
      gap: { rmse: 0.6, count: 10 },
    });
    const c = checkCalibration(r);
    expect(c.assessable).toBe(true);
    expect(c.calibrated).toBe(true);
    expect(c.score).toBe(1);
  });

  it('fails when a high-confidence band has higher error (theater)', () => {
    const r = report({
      solid: { rmse: 0.6, count: 10 },
      dashed: { rmse: 0.2, count: 10 },
    });
    const c = checkCalibration(r);
    expect(c.assessable).toBe(true);
    expect(c.calibrated).toBe(false);
    expect(c.reason).toMatch(/miscalibrated/i);
  });

  it('is not assessable with fewer than two adequately-sampled bands', () => {
    const r = report({ solid: { rmse: 0.1, count: 10 } });
    const c = checkCalibration(r);
    expect(c.assessable).toBe(false);
    expect(c.calibrated).toBe(false);
    expect(Number.isNaN(c.score)).toBe(true);
  });

  it('tolerates small noise within the tolerance band', () => {
    // solid marginally worse than dashed, but within 15%.
    const r = report({
      solid: { rmse: 0.31, count: 10 },
      dashed: { rmse: 0.3, count: 10 },
    });
    const c = checkCalibration(r);
    expect(c.calibrated).toBe(true);
  });

  it('ignores bands below the minimum sample count', () => {
    const r = report({
      solid: { rmse: 0.1, count: 10 },
      dashed: { rmse: 0.05, count: 2 }, // too few → ignored
      gap: { rmse: 0.4, count: 10 },
    });
    const c = checkCalibration(r);
    // Only solid + gap considered; 0.1 <= 0.4 → calibrated.
    expect(c.consideredBands.map((b) => b.grade)).toEqual(['solid', 'gap']);
    expect(c.calibrated).toBe(true);
  });
});
