/**
 * ValidationReport.ts
 *
 * Validation report shared types. The validation harness turns the honesty
 * contract from a claim into a measurement: it withholds known ground
 * returns, rebuilds the DTM without them, and reports how far the
 * rebuilt surface missed the truth — overall and per confidence band.
 *
 * This is the artifact that makes "evidence-graded" honest: if the
 * solid (high-confidence) band does not actually have lower error than
 * the dashed/gap bands, the grading is decorative and the calibration
 * check fails. Pure data: no DOM, no three.js, no I/O.
 */

import type { TerrainCoverageMode } from '../TerrainContracts';
import type { EvidenceGrade } from '../ground/cellConfidence';

/** Error statistics for one evidence band. */
export interface BandError {
  readonly grade: EvidenceGrade;
  /** Held-out points that fell in cells of this band. */
  readonly count: number;
  /** Root-mean-square vertical residual, source linear units. NaN if count 0. */
  readonly rmse: number;
  /** Mean absolute vertical residual. NaN if count 0. */
  readonly mae: number;
}

/** The result of a hold-out cross-validation pass. */
export interface ValidationReport {
  /** Root-mean-square vertical residual across all covered held-out points. */
  readonly rmse: number;
  /** Mean absolute residual. */
  readonly mae: number;
  /** 95th-percentile absolute residual. */
  readonly p95: number;
  /** Held-out points that landed in a covered cell (used in the stats). */
  readonly sampleSize: number;
  /** Held-out points whose cell had no training data (could not predict). */
  readonly uncoveredCount: number;
  /** The hold-out fraction actually used. */
  readonly holdoutFraction: number;
  /** Per-band breakdown, ordered solid → dashed → gap. */
  readonly perBand: ReadonlyArray<BandError>;
  /** Method tag for the deliverable, e.g. "holdout-cross-validation". */
  readonly method: string;
  /** Coverage mode inherited from the underlying DTM build. */
  readonly coverageMode: TerrainCoverageMode;
  /** Ordered, human-readable caveats. */
  readonly warnings: string[];
}

/** The result of asserting that confidence predicts error. */
export interface CalibrationResult {
  /**
   * True when the evidence grading is calibrated: higher-confidence
   * bands have lower (or statistically equal) error than lower-
   * confidence bands. False when the ordering is violated.
   */
  readonly calibrated: boolean;
  /**
   * Whether calibration could be assessed at all. Needs at least two
   * bands with enough samples; otherwise `false` and `calibrated` is
   * not meaningful.
   */
  readonly assessable: boolean;
  /** Fraction of adjacent band pairs that satisfy monotonicity (0..1). NaN if not assessable. */
  readonly score: number;
  /** Human-readable explanation of the verdict. */
  readonly reason: string;
  /** The band errors the check considered (count >= min samples). */
  readonly consideredBands: ReadonlyArray<BandError>;
}
