/**
 * calibrateConfidence.ts
 *
 * Pure-data leaf — turns the heuristic confidence into a MEASURED
 * one. The heuristic (`cellConfidence.ts`) is an informed guess from
 * density, interpolation distance, and roughness; this module asks the
 * hold-out evidence whether that guess is true and rewrites it so the
 * number means what it says.
 *
 * Definition (documented so it can be argued with): the calibrated
 * confidence of a cell is the empirical probability that the cell's
 * elevation is within a stated vertical tolerance τ of ground truth,
 * estimated from held-out points whose predicted (raw) confidence was
 * similar. So "80% confident" after calibration means "≈80% of held-out
 * points with this raw confidence landed within τ of the rebuilt
 * surface" — a falsifiable claim, not decoration.
 *
 * Method:
 *   1. Bin the held-out (rawConfidence, |error|) samples by raw
 *      confidence.
 *   2. Per bin, reliability = fraction with |error| ≤ τ.
 *   3. Enforce monotonicity with pool-adjacent-violators (PAV) isotonic
 *      regression — calibration must be non-decreasing in raw confidence,
 *      and sampling noise can violate that locally.
 *   4. Expose a piecewise-linear remap rawConfidence → calibrated %,
 *      flat-extrapolated past the end bins.
 *
 * Honesty guard: with too few samples, or no usable tolerance, the fit is
 * NOT assessable and `remap` is the identity — we never invent a
 * calibration curve from noise. No DOM, no three.js, no I/O.
 */

import type { ConfidenceSample } from './ValidationReport';
import type { DtmGrid } from '../ground/cellConfidence';

/**
 * Out-of-fold assessment of a calibration — the ANTI-CIRCULARITY guard.
 *
 * The applied {@link ConfidenceCalibration.curve} is fit on ALL held-out
 * samples (correct: it is then applied to *live* grid cells it has never seen).
 * Its QUALITY, however, must not be judged on the same points it was fit from —
 * that would be self-validation. This block is produced by K-fold cross-fitting:
 * each sample is scored by a curve trained only on the OTHER folds, so no point
 * is ever graded by a calibrator that saw it. These are the honest numbers to
 * quote for "how good is the calibration".
 */
export interface CalibrationEvaluation {
  /** True when at least one fold could be fit and scored out-of-fold. */
  readonly crossValidated: boolean;
  /** Number of cross-fitting folds used. */
  readonly folds: number;
  /** Held-out samples actually scored out-of-fold. */
  readonly sampleSize: number;
  /** Out-of-fold empirical reliability: fraction of scored samples within τ. */
  readonly reliability: number;
  /**
   * Out-of-fold Brier score: mean squared error between the calibrated
   * probability a fold's curve predicted for a sample and whether that sample
   * was actually within τ. Lower is better. Because every prediction comes from
   * a curve that never saw the sample, this cannot be gamed by memorisation —
   * an in-sample (self-scored) Brier would look artificially good.
   */
  readonly brier: number;
}

/** A fitted confidence calibration. */
export interface ConfidenceCalibration {
  /** True when there was enough evidence to fit a real curve. */
  readonly assessable: boolean;
  /** The vertical tolerance τ the reliability is defined against. */
  readonly toleranceM: number;
  /** Held-out sample count the fit used. */
  readonly sampleSize: number;
  /** The fitted curve: ascending raw-confidence knots → calibrated %. */
  readonly curve: ReadonlyArray<{ rawConfidence: number; calibrated: number; count: number }>;
  /** Map a raw 0..100 confidence to its calibrated 0..100 value. */
  remap(rawConfidence: number): number;
  /**
   * Out-of-fold quality of this calibration (see {@link CalibrationEvaluation}).
   * Present whenever cross-fitting ran; absent for a non-assessable identity fit.
   * This is the number to report — the curve was NOT scored on its own fit set.
   */
  readonly evaluation?: CalibrationEvaluation;
}

/** Options for {@link fitConfidenceCalibration}. */
export interface CalibrationFitParams {
  /** Vertical tolerance τ for "within tolerance". Must be finite & > 0. */
  readonly toleranceM: number | null;
  /**
   * Vertical noise floor for τ, source linear units. The effective
   * tolerance is `max(toleranceM, toleranceFloorM)`. Without it, a
   * near-perfect surface has a vanishingly small measured RMSE, every
   * held-out residual exceeds it, reliability collapses to 0, and the
   * calibration would wrongly map an excellent surface to ~0% confidence.
   * The floor says "we don't claim to resolve vertical differences below
   * this", so a surface accurate to within the floor reads as fully
   * reliable. Default 0.01 m (1 cm). Set 0 to disable.
   */
  readonly toleranceFloorM?: number;
  /** Minimum held-out samples to attempt a fit. Default 40. */
  readonly minSamples?: number;
  /** Number of equal-width confidence bins over [0,100]. Default 10. */
  readonly bins?: number;
  /**
   * Minimum samples a BIN needs before it may contribute a curve knot.
   * Default 5. The same honesty guard as `minSamples`, at bin granularity:
   * a 2-sample bin's "reliability" is a coin flip, and because the remap is
   * flat-extrapolated past the end knots, one noisy near-empty low bin used
   * to drag EVERY low-raw-confidence cell on the live grid down with it
   * (surfaced by v0.4.5's unified hold-out surface, whose extrapolation
   * guard legitimately produces a few very-low-confidence samples).
   */
  readonly minBinCount?: number;
  /**
   * Cross-fit the calibration's QUALITY so it is never scored on its own fit
   * set (anti-circularity). On by default. The applied curve is unchanged; this
   * only controls whether {@link ConfidenceCalibration.evaluation} is computed.
   */
  readonly crossValidate?: boolean;
  /** Number of cross-fitting folds. Default 5, floored at 2. */
  readonly cvFolds?: number;
  /**
   * Deterministic fold-assignment offset. Fold of sample i is `(i + seed) % K`,
   * so the assessment is reproducible (no PRNG state) yet controllable. Default 0.
   */
  readonly seed?: number;
}

const identity: ConfidenceCalibration = {
  assessable: false,
  toleranceM: Number.NaN,
  sampleSize: 0,
  curve: [],
  remap: (c) => c,
};

/** A fitted curve plus its remap — the reusable core, fold-agnostic. */
interface FittedCurve {
  readonly curve: ReadonlyArray<{ rawConfidence: number; calibrated: number; count: number }>;
  remap(rawConfidence: number): number;
}

/**
 * Build the binned + isotonic (PAV) calibration curve from a set of samples.
 * Returns null when fewer than two bins clear the occupancy floor (no honest
 * curve). This is the shared kernel used both for the applied all-data curve
 * and for each cross-fitting fold, so a fold is fit EXACTLY like the whole.
 */
function buildCurve(
  samples: ReadonlyArray<ConfidenceSample>,
  tol: number,
  binCount: number,
  minBinCount: number,
): FittedCurve | null {
  // 1) Bin by raw confidence and measure reliability per bin.
  const binSum = new Array<number>(binCount).fill(0); // sum of raw conf
  const binHit = new Array<number>(binCount).fill(0); // within-tol count
  const binN = new Array<number>(binCount).fill(0);
  for (const s of samples) {
    const c = clamp(s.confidence, 0, 100);
    let b = Math.floor((c / 100) * binCount);
    if (b >= binCount) b = binCount - 1;
    binSum[b] += c;
    binN[b] += 1;
    if (s.absError <= tol) binHit[b] += 1;
  }

  // Collect adequately-populated bins as (meanConf, reliability, count),
  // ascending. Bins below the occupancy floor are EXCLUDED, not merged: a
  // handful of samples cannot establish a reliability, and a noisy end bin
  // would otherwise set the flat-extrapolated value for everything beyond it.
  const pts: Array<{ x: number; y: number; w: number }> = [];
  for (let b = 0; b < binCount; b++) {
    if (binN[b] < minBinCount) continue;
    pts.push({ x: binSum[b] / binN[b], y: binHit[b] / binN[b], w: binN[b] });
  }
  if (pts.length < 2) return null;

  // 2) PAV isotonic regression — make reliability non-decreasing in x,
  //    weighted by bin count.
  const iso = poolAdjacentViolators(pts);

  const curve = iso.map((p) => ({
    rawConfidence: p.x,
    calibrated: clamp(p.y * 100, 0, 100),
    count: p.w,
  }));

  const remap = (rawConfidence: number): number => {
    const c = clamp(rawConfidence, 0, 100);
    if (c <= curve[0].rawConfidence) return curve[0].calibrated;
    const last = curve[curve.length - 1];
    if (c >= last.rawConfidence) return last.calibrated;
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1];
      const b = curve[i];
      if (c <= b.rawConfidence) {
        const span = b.rawConfidence - a.rawConfidence;
        const t = span > 1e-9 ? (c - a.rawConfidence) / span : 0;
        return a.calibrated + t * (b.calibrated - a.calibrated);
      }
    }
    return last.calibrated;
  };

  return { curve, remap };
}

/**
 * Cross-fit the calibration's quality: K folds, each scored by a curve trained
 * ONLY on the other folds, so no sample is graded by a calibrator that saw it.
 * Deterministic — fold of sample i is `(i + seed) % K`. Returns a
 * non-crossValidated block when no fold could be fit.
 */
function crossFitEvaluation(
  samples: ReadonlyArray<ConfidenceSample>,
  tol: number,
  binCount: number,
  minBinCount: number,
  folds: number,
  seed: number,
): CalibrationEvaluation {
  const K = Math.max(2, Math.floor(folds));
  const foldOf = (i: number) => (((i + seed) % K) + K) % K;
  let scored = 0;
  let within = 0;
  let sumBrier = 0;
  for (let f = 0; f < K; f++) {
    const trainSamples: ConfidenceSample[] = [];
    for (let i = 0; i < samples.length; i++) {
      if (foldOf(i) !== f) trainSamples.push(samples[i]);
    }
    const fit = buildCurve(trainSamples, tol, binCount, minBinCount);
    if (!fit) continue; // this fold's training set could not establish a curve
    for (let i = 0; i < samples.length; i++) {
      if (foldOf(i) !== f) continue;
      const s = samples[i];
      const pred = clamp(fit.remap(s.confidence), 0, 100) / 100;
      const w = s.absError <= tol ? 1 : 0;
      sumBrier += (pred - w) * (pred - w);
      within += w;
      scored++;
    }
  }
  if (scored === 0) {
    return { crossValidated: false, folds: K, sampleSize: 0, reliability: Number.NaN, brier: Number.NaN };
  }
  return {
    crossValidated: true,
    folds: K,
    sampleSize: scored,
    reliability: within / scored,
    brier: sumBrier / scored,
  };
}

/** Fit a calibration from held-out (confidence, error) samples. */
export function fitConfidenceCalibration(
  samples: ReadonlyArray<ConfidenceSample>,
  params: CalibrationFitParams,
): ConfidenceCalibration {
  const minSamples = params.minSamples ?? 40;
  const binCount = Math.max(2, Math.floor(params.bins ?? 10));
  const rawTol = params.toleranceM;
  if (rawTol == null || !Number.isFinite(rawTol) || rawTol <= 0) return identity;
  // Floor τ at the vertical noise floor so a near-perfect surface (tiny
  // RMSE) reads as reliable rather than collapsing to 0% confidence.
  const floor = Math.max(0, params.toleranceFloorM ?? 0.01);
  const tol = Math.max(rawTol, floor);
  if (samples.length < minSamples) return { ...identity, toleranceM: tol, sampleSize: samples.length };

  const minBinCount = Math.max(1, Math.floor(params.minBinCount ?? 5));

  // The APPLIED curve is fit on ALL held-out samples — correct, because it is
  // then applied to *live* grid cells the fit never saw. Its QUALITY is judged
  // separately, out-of-fold, so it is never scored on its own fit set.
  const built = buildCurve(samples, tol, binCount, minBinCount);
  if (!built) return { ...identity, toleranceM: tol, sampleSize: samples.length };

  const crossValidate = params.crossValidate ?? true;
  const evaluation = crossValidate
    ? crossFitEvaluation(samples, tol, binCount, minBinCount, params.cvFolds ?? 5, params.seed ?? 0)
    : undefined;

  return {
    assessable: true,
    toleranceM: tol,
    sampleSize: samples.length,
    curve: built.curve,
    remap: built.remap,
    ...(evaluation ? { evaluation } : {}),
  };
}

/**
 * Apply a calibration to a DtmGrid, returning a new grid whose confidence
 * is the calibrated value. Coverage, heights, and everything else are
 * unchanged; `meanConfidence` is recomputed. A non-assessable calibration
 * returns the grid untouched.
 */
export function applyConfidenceCalibration(
  grid: DtmGrid,
  calibration: ConfidenceCalibration,
): DtmGrid {
  if (!calibration.assessable) return grid;
  const n = grid.confidence.length;
  const confidence = new Float32Array(n);
  let sum = 0;
  let cells = 0;
  for (let i = 0; i < n; i++) {
    if (grid.coverage[i] === 2) {
      // MEASURED cell. The held-out samples are measured ground truth, so the
      // calibration is a calibration of the MEASURED surface — apply it here.
      confidence[i] = Math.round(clamp(calibration.remap(grid.confidence[i]), 0, 100));
      sum += confidence[i];
      cells++;
    } else if (grid.coverage[i] === 1) {
      // INTERPOLATED cell. No held-out ground truth backs an invented value, and
      // on a dense scan every sample lands in a measured (high-raw) cell, so the
      // curve's lowest knot is high — remapping an interpolated cell would
      // flat-extrapolate that high value down and read FAR interpolation as
      // "strong" (the all-yellow bug). Keep the honest geometric confidence,
      // which already falls off with interpolation distance.
      confidence[i] = grid.confidence[i];
      sum += confidence[i];
      cells++;
    } else {
      confidence[i] = 0;
    }
  }
  // Honesty: the applied curve was fit on all held-out samples, but its quality
  // is reported OUT-OF-FOLD (cross-fit) so it is not self-validated. Surface both
  // facts in the warning when the evaluation is available.
  const ev = calibration.evaluation;
  const evNote =
    ev && ev.crossValidated
      ? `; quality assessed out-of-fold (${ev.folds}-fold cross-fit, ${ev.sampleSize} samples: reliability ${(ev.reliability * 100).toFixed(0)}%, Brier ${ev.brier.toFixed(3)})`
      : '';
  return {
    ...grid,
    confidence,
    meanConfidence: cells > 0 ? sum / cells : Number.NaN,
    warnings: [
      ...grid.warnings,
      `confidence calibrated against measured error (tolerance ${calibration.toleranceM.toFixed(2)} m, ${calibration.sampleSize} held-out samples)${evNote}`,
    ],
  };
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Pool-Adjacent-Violators isotonic regression. Returns a non-decreasing
 * fit of `y` over ascending `x`, weighted by `w`. Input is assumed sorted
 * by `x` ascending (bins are).
 */
function poolAdjacentViolators(
  pts: ReadonlyArray<{ x: number; y: number; w: number }>,
): Array<{ x: number; y: number; w: number }> {
  // Each block holds a pooled mean y, total weight, and the x of its
  // right-most member (used as the knot location).
  const blocks: Array<{ x: number; y: number; w: number }> = [];
  for (const p of pts) {
    let cur = { x: p.x, y: p.y, w: p.w };
    while (blocks.length > 0 && blocks[blocks.length - 1].y > cur.y) {
      const prev = blocks.pop() as { x: number; y: number; w: number };
      const w = prev.w + cur.w;
      cur = { x: cur.x, y: (prev.y * prev.w + cur.y * cur.w) / w, w };
    }
    blocks.push(cur);
  }
  return blocks;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}
