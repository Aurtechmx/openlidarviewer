/**
 * icpRegister.ts
 *
 * ICP-lite: a coarse rigid alignment of one point cloud onto another, with an
 * honestly REPORTED residual. The change-detection pipeline can already flag
 * when two epochs are mis-co-registered (different origin / CRS / vertical
 * datum); it could not DO anything about a small residual misalignment. This is
 * that missing prerequisite — a way to snap two epochs together before
 * differencing them.
 *
 * Scope, deliberately constrained for honesty:
 *   - Solves a PLANAR rigid transform: a full 3-D translation plus a yaw
 *     (rotation about the world up axis). This covers the dominant misalignment
 *     between two georeferenced survey epochs — a horizontal + vertical shift
 *     and a heading drift — without a general 6-DOF rotation. Pitch/roll are NOT
 *     solved; a cloud that is tilted relative to its pair will not fully align,
 *     and the residual will say so.
 *   - Returns the final RMS nearest-neighbour residual and REFUSES (sets
 *     `refused`) when that residual exceeds the caller's threshold. A coarse
 *     aligner that "looks locked" but is confidently wrong is the failure mode
 *     to avoid; the residual is the falsifiable signal that prevents it.
 *
 * Pure: no three.js, no DOM. Nearest-neighbour is brute-force O(N·M) per
 * iteration, so callers pass DOWNSAMPLED key points (a few thousand), not full
 * clouds — the same way real ICP runs on a sampled subset.
 */

import { NeumaierSum } from '../../process/numerics';

/** A point as [x, y, z]. World up is +Z (the yaw axis). */
export type Vec3 = readonly [number, number, number];

export interface IcpOptions {
  /** Max iterations. Default 25. */
  readonly maxIterations?: number;
  /** Converged when the RMS residual improves by less than this. Default 1e-5. */
  readonly tolerance?: number;
  /**
   * Refuse the result when the final RMS residual (in the clouds' own units)
   * exceeds this. Default Infinity (never refuse — caller inspects the residual
   * itself). Set it to the survey's own noise floor to gate honestly.
   */
  readonly maxResidual?: number;
  /**
   * Fraction of best-residual correspondences to keep when solving each
   * iteration — a trimmed ICP (TrICP). Default 1: use every correspondence, the
   * classic solve, unchanged. Set it below 1 (e.g. 0.7 to reject the worst 30%)
   * when the pair only partially overlaps or carries gross outliers — moving
   * objects, vegetation, a second surface — that a plain least-squares would let
   * drag the fit off true.
   *
   * Trimming is only trustworthy from a sensible starting alignment, and the
   * raw-centroid warm start is not one when outliers are present: a centroid
   * computed over an outlier-heavy cloud sits away from the real surface, so the
   * first correspondences — and therefore the "best" ones the trim keeps — are
   * whichever outliers happen to land near a target point, and the trim
   * collapses onto them. So whenever trimming is active the warm start switches
   * to a per-axis MEDIAN alignment, which a minority of outliers cannot move,
   * giving the trim a real surface to select inliers from on the very first
   * iteration. Clamped to [0.05, 1].
   */
  readonly trimFraction?: number;
}

export interface IcpResult {
  /** RMS improvement fell below `tolerance` before hitting `maxIterations`. */
  readonly converged: boolean;
  /** Final RMS residual exceeded `maxResidual` — do NOT trust this alignment. */
  readonly refused: boolean;
  /** Iterations actually run. */
  readonly iterations: number;
  /**
   * Final RMS nearest-neighbour distance after alignment, in cloud units. With
   * no trimming (`trimFraction` 1) this is the RMS over ALL source points. With
   * trimming it is the RMS over the KEPT best-`trimFraction` correspondences —
   * the objective actually minimised — so it reports how tightly the inliers
   * registered, NOT an average diluted by the rejected outliers. Read it beside
   * `inlierFraction`, which independently discloses how much was rejected.
   */
  readonly rmsResidual: number;
  /** Solved transform: applies as `R(yaw)·p + translation` mapping source→target. */
  readonly yawRad: number;
  readonly translation: Vec3;
  /** Empty/degenerate input (fewer than 3 points in either cloud). */
  readonly degenerate: boolean;
  /**
   * Fraction of source points whose final nearest-neighbour distance is within
   * `maxResidual` — a REPORTED overlap/inlier diagnostic, not used to steer the
   * solve. Low overlap (say < 0.5) with a small RMS is the classic "locked onto
   * a subset" failure the RMS alone hides. Trivially 1 when `maxResidual` is
   * Infinity (no tolerance set to measure against).
   */
  readonly inlierFraction: number;
  /**
   * The effective trim fraction used (echo of the clamped `trimFraction`
   * option; 1 when no trimming). Makes the solve's outlier-rejection visible to
   * a reader rather than hidden inside the fit.
   */
  readonly trimFraction: number;
}

/** Apply a solved ICP transform to a point: R(yaw)·p + t. */
export function applyIcp(result: Pick<IcpResult, 'yawRad' | 'translation'>, p: Vec3): Vec3 {
  const c = Math.cos(result.yawRad);
  const s = Math.sin(result.yawRad);
  const [tx, ty, tz] = result.translation;
  return [c * p[0] - s * p[1] + tx, s * p[0] + c * p[1] + ty, p[2] + tz];
}

function centroid(pts: readonly Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p[0]; y += p[1]; z += p[2]; }
  const n = pts.length || 1;
  return [x / n, y / n, z / n];
}

/** Centroid over a subset of `pts` given by `idx` (used by the trimmed solve). */
function centroidIdx(pts: readonly Vec3[], idx: readonly number[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const i of idx) { x += pts[i][0]; y += pts[i][1]; z += pts[i][2]; }
  const n = idx.length || 1;
  return [x / n, y / n, z / n];
}

/** Median of a number list (deterministic; even length averages the middle two). */
function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = vals.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Per-axis median of a cloud — an outlier-resistant centre. A minority of gross
 * outliers cannot move it (unlike the mean/centroid), so it is the warm-start
 * anchor for the trimmed solve.
 */
function medianPoint(pts: readonly Vec3[]): Vec3 {
  const xs: number[] = new Array(pts.length);
  const ys: number[] = new Array(pts.length);
  const zs: number[] = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) { xs[i] = pts[i][0]; ys[i] = pts[i][1]; zs[i] = pts[i][2]; }
  return [median(xs), median(ys), median(zs)];
}

/** Nearest target point to `p` (brute force). Returns its index + squared dist. */
function nearest(p: Vec3, target: readonly Vec3[]): { index: number; d2: number } {
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < target.length; i++) {
    const t = target[i];
    const dx = p[0] - t[0], dy = p[1] - t[1], dz = p[2] - t[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return { index: best, d2: bestD2 };
}

/**
 * Align `source` onto `target` with a planar rigid ICP. The transform maps a
 * source point to target space; see {@link applyIcp}.
 */
export function icpRegister(
  source: readonly Vec3[],
  target: readonly Vec3[],
  options: IcpOptions = {},
): IcpResult {
  const maxIterations = options.maxIterations ?? 25;
  const tolerance = options.tolerance ?? 1e-5;
  const maxResidual = options.maxResidual ?? Infinity;
  const rawTrim = options.trimFraction ?? 1;
  const trimFraction = Math.max(0.05, Math.min(1, Number.isFinite(rawTrim) ? rawTrim : 1));
  const trimming = trimFraction < 1;

  if (source.length < 3 || target.length < 3) {
    return {
      converged: false, refused: true, iterations: 0, rmsResidual: Infinity,
      yawRad: 0, translation: [0, 0, 0], degenerate: true, inlierFraction: 0,
      trimFraction,
    };
  }

  /** Smallest keep-count for the trim (never fewer than 3, the solve's floor). */
  const keepCount = (n: number): number =>
    trimming ? Math.max(3, Math.min(n, Math.ceil(trimFraction * n))) : n;

  // Accumulated transform (source→target), composed each iteration.
  let yaw = 0;
  let t: Vec3 = [0, 0, 0];
  // Warm start: place source over target so the first correspondences are
  // meaningful. Without trimming, align centroids (the mean is the right centre
  // for a full least-squares). With trimming, align per-axis MEDIANS instead:
  // the trim is about to reject outliers, and a centroid warm start computed
  // over those very outliers would seed the trim onto them (the collapse this
  // guards against) — the median is unmoved by a minority of outliers, so the
  // trim selects real inliers from the first iteration.
  {
    const cs = trimming ? medianPoint(source) : centroid(source);
    const ct = trimming ? medianPoint(target) : centroid(target);
    t = [ct[0] - cs[0], ct[1] - cs[1], ct[2] - cs[2]];
  }

  let prevRms = Infinity;
  let rms = Infinity;
  let iter = 0;
  let converged = false;

  for (; iter < maxIterations; iter++) {
    // 1. Transform source by the current estimate and find correspondences,
    //    keeping each squared residual so the trim can rank them.
    const moved: Vec3[] = source.map((p) => applyIcp({ yawRad: yaw, translation: t }, p));
    const corr: Vec3[] = new Array(moved.length);
    const d2s: number[] = new Array(moved.length);
    for (let i = 0; i < moved.length; i++) {
      const { index, d2 } = nearest(moved[i], target);
      corr[i] = target[index];
      d2s[i] = d2;
    }

    // 2. Select the correspondences the solve is allowed to use. Without
    //    trimming that is all of them; with trimming, the best-residual
    //    `trimFraction` — the outliers (largest residuals) are dropped so they
    //    cannot drag the least-squares. Ties break by index for determinism.
    const order: number[] = d2s.map((_, i) => i);
    if (trimming) order.sort((a, b) => (d2s[a] - d2s[b]) || (a - b));
    const kept = trimming ? order.slice(0, keepCount(order.length)) : order;

    // RMS over the KEPT set — the objective being minimised (see rmsResidual).
    // Compensated: the residual sum drives the convergence test, so drift here
    // would show up as a false converge/refuse on a large correspondence set.
    const sumD2 = new NeumaierSum();
    for (const i of kept) sumD2.add(d2s[i]);
    rms = Math.sqrt(sumD2.total / kept.length);

    // 3. Best incremental (yaw, translation) mapping the kept `moved` onto
    //    `corr`. Centre both sets; yaw is the closed-form 2-D rotation
    //    least-squares (Umeyama in the ground plane); translation closes the
    //    centroids in 3-D.
    const cm = centroidIdx(moved, kept);
    const cc = centroidIdx(corr, kept);
    let sxy = 0; // Σ (mx·cy − my·cx)  → sin term
    let cxy = 0; // Σ (mx·cx + my·cy)  → cos term
    for (const i of kept) {
      const mx = moved[i][0] - cm[0], my = moved[i][1] - cm[1];
      const cx = corr[i][0] - cc[0], cy = corr[i][1] - cc[1];
      sxy += mx * cy - my * cx;
      cxy += mx * cx + my * cy;
    }
    const dYaw = Math.atan2(sxy, cxy);
    // Apply the incremental rotation about `cm`, then close centroids.
    const cYaw = Math.cos(dYaw), sYaw = Math.sin(dYaw);
    // Rotated centroid of `moved` about cm == cm (rotation is about its own
    // centroid), so the translation that maps it onto `cc` is simply cc − cm.
    const dtx = cc[0] - cm[0];
    const dty = cc[1] - cm[1];
    const dtz = cc[2] - cm[2];

    // 3. Compose the increment (rotate about cm, then translate) into (yaw, t).
    //    New map: p → R(dYaw)·(R(yaw)·p + t − cm) + cm + d
    //           = R(yaw+dYaw)·p + [R(dYaw)·(t − cm) + cm + d]
    const txAdj = t[0] - cm[0], tyAdj = t[1] - cm[1];
    const newTx = cYaw * txAdj - sYaw * tyAdj + cm[0] + dtx;
    const newTy = sYaw * txAdj + cYaw * tyAdj + cm[1] + dty;
    const newTz = t[2] + dtz;
    yaw += dYaw;
    t = [newTx, newTy, newTz];

    if (Math.abs(prevRms - rms) < tolerance) { converged = true; iter++; break; }
    prevRms = rms;
  }

  // Final residuals at the converged transform. `inlierFraction` counts source
  // points within `maxResidual` of a target point over the WHOLE cloud, so it
  // honestly discloses any rejected outliers even when the fit is otherwise
  // tight. `finalRms` mirrors the objective: over all points with no trimming,
  // or over the best-`trimFraction` (the inliers) when trimming — never diluted
  // by outliers the solve deliberately excluded.
  let inliers = 0;
  const maxD2 = maxResidual * maxResidual;
  const finalD2: number[] = new Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const m = applyIcp({ yawRad: yaw, translation: t }, source[i]);
    const { d2 } = nearest(m, target);
    finalD2[i] = d2;
    if (d2 <= maxD2) inliers++;
  }
  const inlierFraction = inliers / source.length;

  let finalRms: number;
  if (trimming) {
    const sorted = finalD2.slice().sort((a, b) => a - b);
    const keep = keepCount(sorted.length);
    const s = new NeumaierSum();
    for (let i = 0; i < keep; i++) s.add(sorted[i]);
    finalRms = Math.sqrt(s.total / keep);
  } else {
    const s = new NeumaierSum();
    for (const d2 of finalD2) s.add(d2);
    finalRms = Math.sqrt(s.total / finalD2.length);
  }

  // Normalise yaw to (−π, π].
  let yawN = yaw % (2 * Math.PI);
  if (yawN > Math.PI) yawN -= 2 * Math.PI;
  if (yawN <= -Math.PI) yawN += 2 * Math.PI;

  return {
    converged,
    refused: finalRms > maxResidual,
    iterations: iter,
    rmsResidual: finalRms,
    yawRad: yawN,
    translation: t,
    degenerate: false,
    inlierFraction,
    trimFraction,
  };
}
