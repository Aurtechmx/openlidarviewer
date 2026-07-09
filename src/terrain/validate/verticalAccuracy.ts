/**
 * verticalAccuracy.ts
 *
 * Reports the hold-out validation result in the form surveyors actually
 * recognise: the ASPRS 2014 vertical accuracy FORMULAS. Bare RMSE is
 * fine internally; "NVA / VVA at 95% confidence" is what surveyors
 * recognise on a deliverable.
 *
 * HONESTY BOUNDARY (why every user-facing label says "-style (hold-out)"):
 * ASPRS 2014 defines NVA/VVA against INDEPENDENT survey checkpoints — GCPs
 * measured by a higher-accuracy method, stratified by land cover. This
 * module applies the same FORMULAS to internally WITHHELD ground points
 * (hold-out cross-validation), which is a genuinely useful accuracy
 * estimate but NOT an ASPRS checkpoint assessment. In particular the
 * VVA-analog here is the 95th percentile of ALL hold-out residuals, not of
 * vegetated-class checkpoints. The math is identical; the CLAIM is weaker,
 * and the labels must say so.
 *
 * Definitions (ASPRS Positional Accuracy Standards for Digital Geospatial
 * Data, 2014):
 *   - RMSEz — root-mean-square vertical error (we measure it by hold-out).
 *   - NVA (Non-vegetated Vertical Accuracy) at 95% = 1.9600 × RMSEz.
 *     This multiplier assumes errors are approximately normally
 *     distributed — true on open, non-vegetated ground.
 *   - VVA (Vegetated Vertical Accuracy) at 95% = the 95th percentile of
 *     the absolute error. Used where errors are NOT normal (vegetation,
 *     mixed cover), so no normal-distribution assumption is made.
 *
 * Both are reported, with the assumption stated, so the number is never
 * an overclaim. Pure data: no DOM, no three.js, no I/O.
 */

import type { ValidationReport } from './ValidationReport';

/** ASPRS 95% multiplier for RMSE → NVA under a normal error model. */
export const NVA_95_MULTIPLIER = 1.96;

/** ASPRS-style vertical accuracy figures derived from a validation report. */
export interface VerticalAccuracy {
  /** RMSEz in source linear units; NaN when not measurable. */
  readonly rmseZ: number;
  /** NVA at 95% = 1.96 × RMSEz (assumes normal errors). NaN when N/A. */
  readonly nva95: number;
  /** VVA at 95% = 95th-percentile absolute error (no normal assumption). NaN when N/A. */
  readonly vva95: number;
  /** Systematic vertical bias (mean signed residual). NaN when N/A. */
  readonly bias: number;
  /** Robust spread: NMAD (1.4826 × MAD). NaN when N/A. */
  readonly nmad: number;
  /** Held-out sample size behind the figures. */
  readonly sampleSize: number;
  /** Standard tag for the deliverable. */
  readonly standard: string;
}

/** Derive ASPRS vertical accuracy figures from a validation report. */
export function computeVerticalAccuracy(report: ValidationReport): VerticalAccuracy {
  const rmseZ = Number.isFinite(report.rmse) ? report.rmse : Number.NaN;
  return {
    rmseZ,
    nva95: Number.isFinite(rmseZ) ? NVA_95_MULTIPLIER * rmseZ : Number.NaN,
    vva95: Number.isFinite(report.p95) ? report.p95 : Number.NaN,
    bias: Number.isFinite(report.bias) ? report.bias : Number.NaN,
    nmad: Number.isFinite(report.nmad) ? report.nmad : Number.NaN,
    sampleSize: report.sampleSize,
    standard: 'ASPRS 2014',
  };
}

/**
 * Human-readable accuracy lines for a panel or PDF. Honest when there is
 * no measurement: a single explained line instead of fake figures.
 */
export function formatVerticalAccuracy(report: ValidationReport, units = 'm'): string[] {
  const a = computeVerticalAccuracy(report);
  if (!Number.isFinite(a.rmseZ)) {
    return ['Vertical accuracy: — (not enough ground points to validate)'];
  }
  const u = ` ${units}`;
  const lines = [
    `Vertical RMSEz: ${a.rmseZ.toFixed(2)}${u} (n=${a.sampleSize}, hold-out)`,
    `NVA-style @ 95% (${a.standard} formula, hold-out): ${a.nva95.toFixed(2)}${u} — ` +
      `assumes normally distributed error; withheld points, not independent checkpoints`,
    `VVA-style @ 95% (percentile, hold-out): ${a.vva95.toFixed(2)}${u} — ` +
      `p95 of ALL residuals, not vegetated-class checkpoints`,
  ];
  // Bias + NMAD expose what RMSE hides: a systematic offset and a robust spread.
  if (Number.isFinite(a.bias)) {
    const sign = a.bias >= 0 ? '+' : '';
    lines.push(
      `Systematic bias: ${sign}${a.bias.toFixed(2)}${u} (mean signed residual, hold-out; ` +
        `${a.bias >= 0 ? 'surface reads low' : 'surface reads high'})`,
    );
  }
  if (Number.isFinite(a.nmad)) {
    lines.push(
      `NMAD (robust spread, hold-out): ${a.nmad.toFixed(2)}${u} — outlier-resistant, ` +
        `trust over RMSEz when errors are non-normal`,
    );
  }
  return lines;
}
