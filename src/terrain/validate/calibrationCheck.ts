/**
 * calibrationCheck.ts
 *
 * calibration check. Given a {@link ValidationReport}, assert
 * that the evidence grading actually predicts error: the solid (high-
 * confidence) band should not have higher residual error than the
 * dashed band, which should not exceed the gap band. If that ordering
 * is violated, the confidence is decorative — "honesty theater" — and
 * this check returns `calibrated: false` with the offending bands.
 *
 * Wired into CI (a unit test), this makes it structurally impossible to
 * ship a regression that breaks the confidence→error correspondence
 * without a test going red.
 *
 * Pure data: no DOM, no three.js, no I/O.
 */

import type {
  BandError,
  CalibrationResult,
  ValidationReport,
} from './ValidationReport';

/** Options for {@link checkCalibration}. */
export interface CalibrationParams {
  /** Minimum held-out samples for a band to be considered. Default 5. */
  readonly minSamplesPerBand?: number;
  /**
   * Relative tolerance when comparing adjacent bands. A higher-
   * confidence band may exceed the next band's error by up to this
   * fraction before the pair is judged miscalibrated (accounts for
   * sampling noise). Default 0.15 (15 %).
   */
  readonly tolerance?: number;
}

/**
 * Assess whether confidence predicts error. Returns an explicit
 * `assessable` flag: with fewer than two adequately-sampled bands the
 * ordering cannot be judged, and `calibrated` is not meaningful.
 */
export function checkCalibration(
  report: ValidationReport,
  params: CalibrationParams = {},
): CalibrationResult {
  const minSamples = params.minSamplesPerBand ?? 5;
  const tolerance = params.tolerance ?? 0.15;

  // Bands ordered by descending confidence (solid → dashed → gap),
  // keeping only those with enough samples and a finite error.
  const considered: BandError[] = report.perBand.filter(
    (b) => b.count >= minSamples && Number.isFinite(b.rmse),
  );

  if (considered.length < 2) {
    return {
      calibrated: false,
      assessable: false,
      score: Number.NaN,
      reason: `not assessable — need >=2 bands with >=${minSamples} samples, have ${considered.length}`,
      consideredBands: considered,
    };
  }

  // Adjacent pairs must be non-decreasing in error within tolerance:
  // a higher-confidence band's RMSE <= the next band's RMSE * (1 + tol).
  let satisfied = 0;
  let total = 0;
  const violations: string[] = [];
  for (let i = 0; i < considered.length - 1; i++) {
    const hi = considered[i]; // higher confidence
    const lo = considered[i + 1]; // lower confidence
    total++;
    if (hi.rmse <= lo.rmse * (1 + tolerance)) {
      satisfied++;
    } else {
      violations.push(
        `${hi.grade} rmse ${hi.rmse.toFixed(3)} > ${lo.grade} rmse ${lo.rmse.toFixed(3)}`,
      );
    }
  }

  const score = total > 0 ? satisfied / total : Number.NaN;
  const calibrated = satisfied === total;
  const reason = calibrated
    ? `calibrated — error is non-increasing with confidence across ${total} band pair(s)`
    : `miscalibrated — ${violations.join('; ')}`;

  return { calibrated, assessable: true, score, reason, consideredBands: considered };
}
