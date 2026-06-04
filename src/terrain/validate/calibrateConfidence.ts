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
}

const identity: ConfidenceCalibration = {
  assessable: false,
  toleranceM: Number.NaN,
  sampleSize: 0,
  curve: [],
  remap: (c) => c,
};

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

  // Collect non-empty bins as (meanConf, reliability, count), ascending.
  const pts: Array<{ x: number; y: number; w: number }> = [];
  for (let b = 0; b < binCount; b++) {
    if (binN[b] === 0) continue;
    pts.push({ x: binSum[b] / binN[b], y: binHit[b] / binN[b], w: binN[b] });
  }
  if (pts.length < 2) return { ...identity, toleranceM: tol, sampleSize: samples.length };

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

  return { assessable: true, toleranceM: tol, sampleSize: samples.length, curve, remap };
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
    if (grid.coverage[i] > 0) {
      confidence[i] = Math.round(clamp(calibration.remap(grid.confidence[i]), 0, 100));
      sum += confidence[i];
      cells++;
    } else {
      confidence[i] = 0;
    }
  }
  return {
    ...grid,
    confidence,
    meanConfidence: cells > 0 ? sum / cells : Number.NaN,
    warnings: [
      ...grid.warnings,
      `confidence calibrated against measured error (tolerance ${calibration.toleranceM.toFixed(2)} m, ${calibration.sampleSize} held-out samples)`,
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
