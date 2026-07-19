/**
 * crossCheck.ts
 *
 * The cross-implementation validation harness (research-hardening Phase 3). It
 * answers one question: does our output agree, cell for cell, with a second,
 * independent implementation (PDAL, GDAL, CloudCompare) within a stated
 * tolerance? Agreement at this level is what the evidence model calls
 * `E4_CROSS_IMPLEMENTATION_VALIDATED` — the first rung above "verified against
 * our own code / our own synthetic data".
 *
 * IMPORTANT — this module computes agreement; it does NOT manufacture it. Per
 * the project's non-negotiable rule, reference outputs are never fabricated.
 * A product reaches E4 only when a real reference file, produced by the
 * documented external procedure (`docs/validation/cross-implementation.md`),
 * is supplied to `crossCheck`. Until then `referenceStatus` is `pending` and
 * the claim stays at its current (≤ E3) level. The unit tests exercise the
 * comparison maths with synthetic arrays; that proves the harness is correct,
 * not that any product is validated.
 *
 * Pure, deterministic, no IO. The caller loads both grids.
 */

import { NeumaierSum } from '../process/numerics';

/** Outcome of comparing our grid to an independent reference grid. */
export type CrossCheckVerdict =
  /** Every compared cell is within tolerance — supports promotion to E4. */
  | 'agree'
  /** At least one compared cell exceeds tolerance — do NOT promote. */
  | 'disagree'
  /** Too few comparable cells to conclude anything. */
  | 'insufficient'
  /** No reference output supplied yet — the honest default. */
  | 'pending';

export interface CrossCheckOptions {
  /** Absolute agreement tolerance, in the value's own unit (e.g. metres for a DTM). */
  readonly toleranceAbs: number;
  /** Value treated as "no data" on either side and skipped. Default: NaN only. */
  readonly nodata?: number;
  /**
   * Minimum comparable cells required to return a verdict other than
   * `insufficient`. Default 8 — enough that a single lucky match can't read as
   * agreement.
   */
  readonly minCells?: number;
  /**
   * Fraction of compared cells that must fall within tolerance for a soft
   * "agree" when a few outliers exist. Default 1.0 (every cell must agree).
   * Clamped to (0, 1]: a value of 0 (which would pass every comparison) is
   * rejected and treated as 1.0.
   */
  readonly withinTolThreshold?: number;
  /**
   * Allow a length mismatch between `ours` and `reference` and compare only the
   * overlapping prefix. Default false: differently-sized grids are not aligned,
   * so agreement over a prefix is meaningless and the verdict is forced to
   * `disagree`. Only set this true after an explicit resample onto a common grid.
   */
  readonly allowPartialOverlap?: boolean;
}

export interface CrossCheckReport {
  readonly verdict: CrossCheckVerdict;
  /** Cells compared (both sides finite and not nodata). */
  readonly count: number;
  /** Cells skipped because one or both sides were nodata / non-finite. */
  readonly skipped: number;
  /** Largest absolute difference over compared cells. */
  readonly maxAbsDiff: number;
  /** Root-mean-square of the differences. */
  readonly rmse: number;
  /** Mean signed difference (ours − reference) — the bias. */
  readonly meanDiff: number;
  /** Fraction of compared cells within `toleranceAbs`. 0..1. */
  readonly withinTolFraction: number;
  /** The tolerance the verdict was computed against. */
  readonly toleranceAbs: number;
  /** Human-readable one-liner for a report / log. */
  readonly summary: string;
}

const isSkippable = (v: number, nodata: number | undefined): boolean =>
  !Number.isFinite(v) || (nodata !== undefined && v === nodata);

/**
 * Compare our values to an independent reference, cell for cell. `ours` and
 * `reference` must be index-aligned (same grid order, same length). Returns a
 * full agreement report; the verdict drives whether a claim may move to E4.
 */
export function crossCheck(
  ours: ArrayLike<number>,
  reference: ArrayLike<number>,
  opts: CrossCheckOptions,
): CrossCheckReport {
  // Validate options up front so a permissive setting can't manufacture an
  // AGREE: a non-finite/negative tolerance, a sub-1 minimum, or a zero
  // agreement threshold are all rejected rather than silently accepted.
  const tol = opts.toleranceAbs;
  if (!Number.isFinite(tol) || tol < 0) {
    return {
      ...pendingCrossCheck(),
      verdict: 'insufficient',
      toleranceAbs: Number.isFinite(tol) ? tol : 0,
      summary: `Invalid tolerance (${tol}); cannot compute agreement.`,
    };
  }
  const nodata = opts.nodata;
  const minCells = Math.max(1, Math.floor(Number.isFinite(opts.minCells) ? (opts.minCells as number) : 8));
  let threshold = opts.withinTolThreshold ?? 1;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) threshold = 1;
  const allowPartial = opts.allowPartialOverlap === true;
  const lengthMismatch = ours.length !== reference.length;
  const n = Math.min(ours.length, reference.length);

  let count = 0;
  let skipped = 0;
  let maxAbsDiff = 0;
  // Compensated so the RMSE over a large grid doesn't drift on the Σd² term.
  const sumSqAcc = new NeumaierSum();
  let sumDiff = 0;
  let within = 0;

  for (let i = 0; i < n; i++) {
    const a = ours[i];
    const b = reference[i];
    if (isSkippable(a, nodata) || isSkippable(b, nodata)) {
      skipped++;
      continue;
    }
    const d = a - b;
    const ad = Math.abs(d);
    count++;
    if (ad > maxAbsDiff) maxAbsDiff = ad;
    sumSqAcc.add(d * d);
    sumDiff += d;
    if (ad <= tol) within++;
  }
  // Any length mismatch counts as skipped so the report is honest about coverage.
  skipped += Math.abs(ours.length - reference.length);

  const rmse = count > 0 ? Math.sqrt(sumSqAcc.total / count) : 0;
  const meanDiff = count > 0 ? sumDiff / count : 0;
  const withinTolFraction = count > 0 ? within / count : 0;

  let verdict: CrossCheckVerdict;
  if (lengthMismatch && !allowPartial) {
    // Differently-sized grids are not aligned; agreement over a prefix would be
    // a false positive. Refuse to call it agreement.
    verdict = 'disagree';
  } else if (count < minCells) verdict = 'insufficient';
  else if (withinTolFraction >= threshold) verdict = 'agree';
  else verdict = 'disagree';

  const summary =
    lengthMismatch && !allowPartial
      ? `Grid length mismatch (${ours.length} vs ${reference.length}); not aligned — resample onto a common grid before comparing.`
      : verdict === 'insufficient'
      ? `Insufficient overlap: ${count} comparable cells (< ${minCells}).`
      : `${verdict === 'agree' ? 'Agrees' : 'Disagrees'} with reference over ${count} cells: ` +
        `max |Δ| ${maxAbsDiff.toPrecision(3)}, RMSE ${rmse.toPrecision(3)}, ` +
        `${(withinTolFraction * 100).toFixed(1)}% within ±${tol} (bias ${meanDiff >= 0 ? '+' : ''}${meanDiff.toPrecision(3)}).`;

  return {
    verdict, count, skipped, maxAbsDiff, rmse, meanDiff,
    withinTolFraction, toleranceAbs: tol, summary,
  };
}

/**
 * The honest default when no reference output exists yet. Returns a `pending`
 * report so the caller / claim register can show "external check: pending"
 * without inventing numbers.
 */
export function pendingCrossCheck(): CrossCheckReport {
  return {
    verdict: 'pending',
    count: 0,
    skipped: 0,
    maxAbsDiff: 0,
    rmse: 0,
    meanDiff: 0,
    withinTolFraction: 0,
    toleranceAbs: 0,
    summary: 'No independent reference output supplied — cross-check pending.',
  };
}

/** A product that can be cross-checked, and the tolerance its agreement uses. */
export interface ReferenceSlot {
  /** Matches a `claimId` in the claim register. */
  readonly claimId: string;
  /** The reference tool that would produce the comparison output. */
  readonly referenceTool: 'PDAL' | 'GDAL' | 'CloudCompare';
  /** Absolute agreement tolerance in the product's unit. */
  readonly toleranceAbs: number;
  /** Unit label for the tolerance, for docs / reports. */
  readonly unit: string;
  /**
   * Whether a real reference output has been supplied. `pending` everywhere in
   * this release — no reference data is bundled or fabricated.
   */
  readonly status: 'pending' | 'supplied';
}

/**
 * The reference-fixture manifest. Every slot is `pending`: the harness is in
 * place and the procedure is documented, but no external reference output has
 * been generated and committed yet, so nothing here has reached E4. When a
 * reference is produced per `docs/validation/cross-implementation.md`, flip its
 * `status` to `supplied` and wire the loaded grids into `crossCheck`.
 */
export const REFERENCE_SLOTS: readonly ReferenceSlot[] = [
  { claimId: 'DTM', referenceTool: 'PDAL', toleranceAbs: 0.05, unit: 'm', status: 'pending' },
  { claimId: 'DSM', referenceTool: 'PDAL', toleranceAbs: 0.05, unit: 'm', status: 'pending' },
  { claimId: 'CHM', referenceTool: 'PDAL', toleranceAbs: 0.10, unit: 'm', status: 'pending' },
  { claimId: 'SLOPE-RASTER', referenceTool: 'GDAL', toleranceAbs: 0.5, unit: '°', status: 'pending' },
  { claimId: 'HILLSHADE', referenceTool: 'GDAL', toleranceAbs: 1.0, unit: '(0–255)', status: 'pending' },
  { claimId: 'CONTOURS', referenceTool: 'GDAL', toleranceAbs: 0.05, unit: 'm', status: 'pending' },
  { claimId: 'GROUND-FILTER', referenceTool: 'PDAL', toleranceAbs: 0, unit: 'class', status: 'pending' },
] as const;

/** True while any reference slot is still pending — i.e. nothing is at E4 yet. */
export const allReferencesPending = (slots: readonly ReferenceSlot[] = REFERENCE_SLOTS): boolean =>
  slots.every((s) => s.status === 'pending');
