/**
 * terrainMetrics.ts — shared comparison numerics for the terrain validation
 * harness (validation-only; imported by studies and tests, not by the viewer).
 *
 * `crossCheck` gives one agree/disagree verdict over a grid; this gives the full
 * error vector a reference-checkpoint or boundary study reports: MAE, RMSE, the
 * median (robust to a few outliers), the signed bias (systematic offset), the
 * worst cell, and the coverage / rejection fractions that keep partial data
 * honest. Aspect is angular and gets its own circular comparator so that 359°
 * and 1° read as 2° apart, never 358°.
 *
 * Pure and deterministic — no DOM, no I/O. NaN and an explicit nodata sentinel
 * are both treated as "no value" and excluded from the paired sample.
 */

/** The paired error summary over two grids. */
export interface GridErrorStats {
  /** Cells compared (finite on both sides). */
  readonly n: number;
  /** Mean absolute error. */
  readonly mae: number;
  /** Root-mean-square error. */
  readonly rmse: number;
  /** Median absolute error — robust to a few large outliers. */
  readonly medianAbsError: number;
  /** Signed mean (ours − ref): a systematic offset, not just spread. */
  readonly signedBias: number;
  /** Largest single absolute error. */
  readonly maxAbsError: number;
  /**
   * Fraction of reference-valued cells that were also valued in `ours` — the
   * share of the reference the candidate actually covered.
   */
  readonly coverage: number;
  /** 1 − coverage: reference cells the candidate left empty. */
  readonly rejectionFraction: number;
}

/** True when a value is a usable sample (finite and not the nodata sentinel). */
function isValue(v: number, nodata: number): boolean {
  return Number.isFinite(v) && v !== nodata;
}

/** Exact median of a numeric array (sorts a copy; empty → NaN). */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Paired error stats over two equal-length grids. `errorOf` maps a paired
 * (ours, ref) to a scalar error — plain difference for a scalar field, circular
 * separation for an angle. `coverage` counts reference cells; a cell valued in
 * the reference but empty in `ours` is a rejection, not an error.
 */
export function gridErrorStats(
  ours: ArrayLike<number>,
  ref: ArrayLike<number>,
  options: { nodata?: number; errorOf?: (ours: number, ref: number) => number } = {},
): GridErrorStats {
  const nodata = options.nodata ?? Number.NaN;
  const errorOf = options.errorOf ?? ((a: number, b: number) => a - b);
  const n = Math.min(ours.length, ref.length);
  let refValued = 0;
  let count = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let sumSigned = 0;
  let maxAbs = 0;
  const absErrors: number[] = [];
  for (let i = 0; i < n; i++) {
    const refOk = isValue(ref[i], nodata);
    if (refOk) refValued++;
    if (!refOk || !isValue(ours[i], nodata)) continue;
    const e = errorOf(ours[i], ref[i]);
    const a = Math.abs(e);
    count++;
    sumAbs += a;
    sumSq += e * e;
    sumSigned += e;
    if (a > maxAbs) maxAbs = a;
    absErrors.push(a);
  }
  const coverage = refValued === 0 ? 0 : count / refValued;
  return {
    n: count,
    mae: count === 0 ? Number.NaN : sumAbs / count,
    rmse: count === 0 ? Number.NaN : Math.sqrt(sumSq / count),
    medianAbsError: median(absErrors),
    signedBias: count === 0 ? Number.NaN : sumSigned / count,
    maxAbsError: maxAbs,
    coverage,
    rejectionFraction: 1 - coverage,
  };
}

/**
 * Circular separation between two aspect bearings, in degrees, in `[0, 180]`.
 * Wraps at 360, so `circularAspectError(359, 1) === 2`. Inputs are normalised
 * into `[0, 360)` first, so an out-of-range or negative bearing is handled.
 */
export function circularAspectError(a: number, b: number): number {
  const norm = (x: number): number => ((x % 360) + 360) % 360;
  const d = Math.abs(norm(a) - norm(b));
  return d > 180 ? 360 - d : d;
}

/** {@link gridErrorStats} specialised to aspect, using the circular comparator. */
export function aspectErrorStats(
  ours: ArrayLike<number>,
  ref: ArrayLike<number>,
  options: { nodata?: number } = {},
): GridErrorStats {
  return gridErrorStats(ours, ref, { nodata: options.nodata, errorOf: circularAspectError });
}
