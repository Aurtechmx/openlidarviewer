/**
 * verticalAccuracy.ts
 *
 * Reports the hold-out validation result in the form surveyors actually
 * recognise: the ASPRS 2014 vertical accuracy statistics. Bare RMSE is
 * fine internally; "NVA / VVA at 95% confidence" is what reads as
 * professional on a deliverable.
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
  return [
    `Vertical RMSEz: ${a.rmseZ.toFixed(2)}${u} (n=${a.sampleSize})`,
    `NVA @ 95% (${a.standard}): ${a.nva95.toFixed(2)}${u} — assumes normally distributed error`,
    `VVA @ 95% (percentile): ${a.vva95.toFixed(2)}${u} — no distribution assumption`,
  ];
}
