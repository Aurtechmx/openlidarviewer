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

/**
 * One held-out point's (predicted confidence, observed error) pair —
 * the raw evidence the confidence calibration is fit from. Collected only
 * when the holdout is asked for it (it is otherwise omitted to keep the
 * report light).
 */
export interface ConfidenceSample {
  /** Predicted (raw heuristic) confidence at the held-out point, 0..100. */
  readonly confidence: number;
  /** Absolute vertical residual at that point, source linear units. */
  readonly absError: number;
  /**
   * Whether the held-out point landed on a measured or interpolated cell.
   * Optional (older callers omit it); the measured-vs-model reliability split
   * uses it to keep an empirical reliability separate from model-based support.
   */
  readonly zone?: SurfaceZone;
}

/** Slope band a held-out point fell in (by local Horn slope). */
export type SlopeBand = 'flat' | 'moderate' | 'steep';

/** Error statistics for one slope band. */
export interface SlopeBandError {
  readonly band: SlopeBand;
  readonly count: number;
  readonly rmse: number;
  readonly mae: number;
}

/** Whether a held-out point landed on measured or interpolated surface. */
export type SurfaceZone = 'measured' | 'interpolated';

/** Error statistics for one surface zone. */
export interface ZoneError {
  readonly zone: SurfaceZone;
  readonly count: number;
  readonly rmse: number;
  readonly mae: number;
}

/** The result of a hold-out cross-validation pass. */
/**
 * What a validation report actually ESTIMATES — the estimand. The four are not
 * interchangeable accuracy figures, and a report typed as one must never be read
 * as another:
 *
 *  - `point-reconstruction` — random-point hold-out. Nearby points from the SAME
 *    local surface stay in training, so it estimates how well the surface
 *    reconstructs a withheld point under DENSE sampling. It is NOT external
 *    accuracy and must not be printed as one.
 *  - `cell-reconstruction` — a whole cell's returns are withheld together.
 *  - `spatial-gap` — spatially-blocked hold-out: complete blocks are assigned to
 *    folds, which changes the spatial arrangement and the local availability of
 *    training support. It does NOT guarantee a minimum separation: a scored
 *    point beside a block boundary can lie arbitrarily close to a training point
 *    in the neighbouring block, so the effective train-test distance varies
 *    within a block and approaches zero at its edges. The contrast against a
 *    random hold-out measures sensitivity to withholding geometry under the
 *    stated protocol. Whether it reports a larger error is an empirical result
 *    of a given run, not a property of the method.
 *  - `external-checkpoint` — residuals against INDEPENDENT survey checkpoints
 *    measured by a higher-accuracy method. Only this estimand may back an ASPRS
 *    conformance claim.
 *
 * Carrying the estimand as a closed union (not a free-text label) is what stops a
 * downstream panel or export from relabelling a point-reconstruction figure as
 * external-checkpoint accuracy.
 */
export type HoldoutEstimand =
  | 'point-reconstruction'
  | 'cell-reconstruction'
  | 'spatial-gap'
  | 'external-checkpoint';

export interface ValidationReport {
  /**
   * What this report estimates. See {@link HoldoutEstimand}. A consumer that
   * prints an accuracy figure MUST key on this before choosing its wording — a
   * `point-reconstruction` report is not external accuracy.
   */
  readonly estimand: HoldoutEstimand;
  /**
   * Which points the ground classification saw, for the surface this report
   * scores. `'train-only'` means the classifier was re-run WITHOUT the held-out
   * points, so the estimand is split-then-classify-then-fit.
   * `'whole-cloud'` means the classification already covered every point, so it
   * is classify-then-split-then-fit and the held-out points influenced the mask
   * that defines ground.
   *
   * Recorded for the same reason {@link HoldoutEstimand} is a closed union: a
   * caller that requested train-only reclassification and hit a failed or empty
   * reclassifier previously received a full-cloud figure with a warning
   * appended, and a warning string does not stop a panel or a paper quoting the
   * number as though the requested treatment had run. Two reports may only be
   * compared as a geometry contrast when this field agrees.
   */
  readonly classificationScope: 'whole-cloud' | 'train-only';
  /**
   * Why no statistic is reported, or null when one is. `sampleSize 0` alone
   * says a figure is missing but not which cause, so every renderer had to
   * guess a reason; the honest ones now read it from here. Set whenever the
   * run refuses: too few ground returns, an invalid statistical parameter, a
   * mask that does not match the cloud, or a requested train-only
   * classification that could not be produced.
   */
  readonly unavailableReason: string | null;
  /** Root-mean-square vertical residual across all covered held-out points. */
  readonly rmse: number;
  /** Mean absolute residual. */
  readonly mae: number;
  /** 95th-percentile absolute residual. */
  readonly p95: number;
  /**
   * Mean SIGNED residual — the systematic vertical bias. Positive ⇒ the held-out
   * points sit above the surface (the surface reads low), negative ⇒ the reverse.
   * NaN when count 0.
   */
  readonly bias: number;
  /**
   * Normalised median absolute deviation (1.4826 × MAD) — a robust, outlier-
   * resistant estimate of the vertical error spread. NaN when count 0.
   */
  readonly nmad: number;
  /** Held-out points that landed in a covered cell (used in the stats). */
  readonly sampleSize: number;
  /** Held-out points whose cell had no training data (could not predict). */
  readonly uncoveredCount: number;
  /** The hold-out fraction actually used. */
  readonly holdoutFraction: number;
  /** Per-band breakdown, ordered solid → dashed → gap. */
  readonly perBand: ReadonlyArray<BandError>;
  /** RMSE/MAE stratified by local slope (flat / moderate / steep). */
  readonly perSlopeBand?: ReadonlyArray<SlopeBandError>;
  /** RMSE/MAE stratified by surface zone (measured / interpolated). */
  readonly perZone?: ReadonlyArray<ZoneError>;
  /** Method tag for the deliverable, e.g. "holdout-cross-validation". */
  readonly method: string;
  /** Coverage mode inherited from the underlying DTM build. */
  readonly coverageMode: TerrainCoverageMode;
  /**
   * Raw (confidence, error) pairs for every covered held-out point —
   * present only when the holdout was run with `collectSamples`. Feeds
   * the confidence calibration fit.
   */
  readonly samples?: ReadonlyArray<ConfidenceSample>;
  /** Ordered, human-readable caveats. */
  readonly warnings: string[];
}

/**
 * The result of asserting that confidence predicts error — an ORDERING
 * check, not a calibration. (Renamed from `CalibrationResult` in v0.5.4:
 * the check only verifies that band error is monotone in confidence; the
 * genuine probability calibration lives in `calibrateConfidence.ts`, and
 * two different things must not share one name.)
 */
export interface ConfidenceOrderingResult {
  /**
   * True when the confidence→error ORDERING holds: higher-confidence
   * bands have lower (or statistically equal) error than lower-
   * confidence bands. False when the ordering is violated.
   */
  readonly orderingConsistent: boolean;
  /**
   * Whether the ordering could be assessed at all. Needs at least two
   * bands with enough samples; otherwise `false` and `orderingConsistent`
   * is not meaningful.
   */
  readonly assessable: boolean;
  /** Fraction of adjacent band pairs that satisfy monotonicity (0..1). NaN if not assessable. */
  readonly score: number;
  /** Human-readable explanation of the verdict. */
  readonly reason: string;
  /** The band errors the check considered (count >= min samples). */
  readonly consideredBands: ReadonlyArray<BandError>;
}
