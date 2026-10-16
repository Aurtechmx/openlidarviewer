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
 * Pure: no three.js, no DOM. Nearest-neighbour runs over a grid index built
 * once per fit (`pointIndex.ts`) and answers exactly what a scan over every
 * target would: the smallest distance, lowest index on a tie. Callers still
 * pass DOWNSAMPLED key points (a few thousand), the way real ICP runs on a
 * sampled subset.
 */

import { NeumaierSum } from '../../process/numerics';
import { symEig3 } from '../../math/symEig3';
import { buildPointIndex, nearestPoint, nearestState } from './pointIndex';

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
  /**
   * Where the solve starts. `'warm'` (default) places the source over the
   * target first: centroids without trimming, per-axis medians with trimming.
   * `'identity'` starts at the unmoved pose, for two clouds already in one
   * coordinate frame: a centre-of-mass warm start then measures the
   * difference in the two FOOTPRINTS, not a misregistration, and on epochs of
   * different extent it moves the source by a large fraction of that
   * difference before the first correspondence is formed.
   */
  readonly initialPose?: 'warm' | 'identity';
  /**
   * Correspondences farther apart than this (cloud units) are rejected in every
   * iteration before the trim, which then keeps the best `trimFraction` of
   * what remains. A source point outside the target's footprint has no true
   * partner; without this bound it pairs with the nearest edge point and
   * drags the solve toward the target. The same distance measures
   * `overlapFraction`. Default Infinity: no rejection, the classic solve.
   */
  readonly maxCorrespondenceDistance?: number;
  /**
   * Error metric of each iteration's solve. `'point'` (default) is the classic
   * point-to-point least squares. `'plane'` minimises the distance of each
   * source point to the tangent plane at its partner (Chen & Medioni 1992),
   * with target normals from a local plane fit within `normalRadius`. Two
   * samplings of one surface never share points, so point-to-point pairs pull
   * toward wherever the target happens to be sampled and stall within about a
   * point spacing of the answer; the plane metric measures the offset from the
   * surface itself. A direction the surface does not constrain (horizontal
   * shift over flat ground) is damped toward no motion rather than guessed.
   */
  readonly metric?: 'point' | 'plane';
  /** Neighbour radius (cloud units) for the target normals of the plane metric. */
  readonly normalRadius?: number;
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
  /**
   * Fraction of source points with a target point within
   * `maxCorrespondenceDistance` at the final pose. Present only when that
   * option is finite; it is the overlap the solve actually used.
   */
  readonly overlapFraction?: number;
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

/**
 * Unit normal per target point from a plane fit to its neighbours within
 * `radius` (smallest-eigenvalue vector of their covariance). NaN where fewer
 * than five neighbours support a fit.
 */
function targetNormals(target: readonly Vec3[], radius: number): Float64Array {
  const n = target.length;
  const out = new Float64Array(3 * n).fill(Number.NaN);
  if (!(radius > 0) || n < 5) return out;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (const p of target) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[2] < minZ) minZ = p[2];
  }
  const key = (ix: number, iy: number, iz: number): string => `${ix},${iy},${iz}`;
  const cells = new Map<string, number[]>();
  const cellOf = (p: Vec3): [number, number, number] => [
    Math.floor((p[0] - minX) / radius),
    Math.floor((p[1] - minY) / radius),
    Math.floor((p[2] - minZ) / radius),
  ];
  for (let i = 0; i < n; i++) {
    const [ix, iy, iz] = cellOf(target[i]);
    const k = key(ix, iy, iz);
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  }
  const r2 = radius * radius;
  for (let i = 0; i < n; i++) {
    const p = target[i];
    const [ix, iy, iz] = cellOf(p);
    let cnt = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = cells.get(key(ix + dx, iy + dy, iz + dz));
      if (!list) continue;
      for (const j of list) {
        const q = target[j];
        const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
        if (ux * ux + uy * uy + uz * uz > r2) continue;
        cnt++; sx += ux; sy += uy; sz += uz;
        sxx += ux * ux; sxy += ux * uy; sxz += ux * uz; syy += uy * uy; syz += uy * uz; szz += uz * uz;
      }
    }
    if (cnt < 5) continue;
    const mx = sx / cnt, my = sy / cnt, mz = sz / cnt;
    const e = symEig3(
      sxx / cnt - mx * mx, sxy / cnt - mx * my, sxz / cnt - mx * mz,
      syy / cnt - my * my, syz / cnt - my * mz, szz / cnt - mz * mz,
    );
    const v = e.vectors[2];
    out[3 * i] = v[0];
    out[3 * i + 1] = v[1];
    out[3 * i + 2] = v[2];
  }
  return out;
}

/**
 * Solve the 4×4 system A·x = b in place by Gaussian elimination with partial
 * pivoting. Returns null when a pivot vanishes.
 */
function solve4(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (!(Math.abs(m[piv][c]) > 0)) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = c + 1; r < 4; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 5; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = [0, 0, 0, 0];
  for (let r = 3; r >= 0; r--) {
    let v = m[r][4];
    for (let k = r + 1; k < 4; k++) v -= m[r][k] * x[k];
    x[r] = v / m[r][r];
  }
  return x;
}

/** Levenberg damping of the plane solve, relative to its largest diagonal term. */
const PLANE_DAMPING = 1e-6;

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
  const rawGate = options.maxCorrespondenceDistance;
  const gated = rawGate !== undefined && Number.isFinite(rawGate) && rawGate >= 0;
  const gateD2 = gated ? (rawGate as number) * (rawGate as number) : Infinity;

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
  // trim selects real inliers from the first iteration. An identity start
  // skips this: the clouds already share a frame.
  if (options.initialPose !== 'identity') {
    const cs = trimming ? medianPoint(source) : centroid(source);
    const ct = trimming ? medianPoint(target) : centroid(target);
    t = [ct[0] - cs[0], ct[1] - cs[1], ct[2] - cs[2]];
  }

  let prevRms = Infinity;
  let rms: number;
  let iter = 0;
  let converged = false;

  // The target is fixed for the whole fit: index it once. The per-iteration
  // buffers are allocated once too and rewritten each pass.
  const index = buildPointIndex(target);
  const plane = options.metric === 'plane';
  const normals = plane ? targetNormals(target, options.normalRadius ?? Number.NaN) : null;
  const n = source.length;
  const mx = new Float64Array(n), my = new Float64Array(n), mz = new Float64Array(n);
  const corr = new Int32Array(n);
  const d2s = new Float64Array(n);
  const order = new Int32Array(n);
  const moveSource = (): void => {
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const [tx, ty, tz] = t;
    for (let i = 0; i < n; i++) {
      const p = source[i];
      mx[i] = c * p[0] - sn * p[1] + tx;
      my[i] = sn * p[0] + c * p[1] + ty;
      mz[i] = p[2] + tz;
    }
  };

  for (; iter < maxIterations; iter++) {
    // 1. Transform source by the current estimate and find correspondences,
    //    keeping each squared residual so the trim can rank them.
    moveSource();
    for (let i = 0; i < n; i++) {
      corr[i] = nearestPoint(index, mx[i], my[i], mz[i]);
      d2s[i] = nearestState.d2;
    }

    // 2. Select the correspondences the solve is allowed to use. Without
    //    trimming that is all of them, in index order; with trimming, the
    //    best-residual `trimFraction`, so the outliers (largest residuals)
    //    cannot drag the least-squares. Ties break by index for determinism.
    //    A correspondence gate first drops every pair beyond it.
    let candidates = 0;
    for (let i = 0; i < n; i++) if (d2s[i] <= gateD2) order[candidates++] = i;
    if (candidates < 3) break;
    if (trimming) order.subarray(0, candidates).sort((a, b) => (d2s[a] - d2s[b]) || (a - b));
    const keep = keepCount(candidates);

    // RMS over the KEPT set — the objective being minimised (see rmsResidual).
    // Compensated: the residual sum drives the convergence test, so drift here
    // would show up as a false converge/refuse on a large correspondence set.
    const sumD2 = new NeumaierSum();
    for (let k = 0; k < keep; k++) sumD2.add(d2s[order[k]]);
    rms = Math.sqrt(sumD2.total / keep);

    // 3. Best incremental (yaw, translation) mapping the kept `moved` onto
    //    `corr`. Centre both sets; yaw is the closed-form 2-D rotation
    //    least-squares (Umeyama in the ground plane); translation closes the
    //    centroids in 3-D.
    let cmx = 0, cmy = 0, cmz = 0, ccx = 0, ccy = 0, ccz = 0;
    for (let k = 0; k < keep; k++) {
      const i = order[k];
      cmx += mx[i]; cmy += my[i]; cmz += mz[i];
      const q = target[corr[i]];
      ccx += q[0]; ccy += q[1]; ccz += q[2];
    }
    const cm: Vec3 = [cmx / keep, cmy / keep, cmz / keep];
    const cc: Vec3 = [ccx / keep, ccy / keep, ccz / keep];
    let sxy = 0; // Σ (mx·cy − my·cx)  → sin term
    let cxy = 0; // Σ (mx·cx + my·cy)  → cos term
    for (let k = 0; k < keep; k++) {
      const i = order[k];
      const q = target[corr[i]];
      const dmx = mx[i] - cm[0], dmy = my[i] - cm[1];
      const cx = q[0] - cc[0], cy = q[1] - cc[1];
      sxy += dmx * cy - dmy * cx;
      cxy += dmx * cx + dmy * cy;
    }
    let dYaw = Math.atan2(sxy, cxy);
    // Rotated centroid of `moved` about cm == cm (rotation is about its own
    // centroid), so the translation that maps it onto `cc` is simply cc − cm.
    let dtx = cc[0] - cm[0];
    let dty = cc[1] - cm[1];
    let dtz = cc[2] - cm[2];
    let step = Infinity;
    if (normals) {
      // Point-to-plane: linearise m' = R(θ)(m − cm) + cm + d about θ = 0 and
      // minimise Σ ((m' − q)·n)² over (θ, dx, dy, dz).
      const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
      const b = [0, 0, 0, 0];
      let used = 0;
      for (let k = 0; k < keep; k++) {
        const i = order[k];
        const j = corr[i];
        const nx = normals[3 * j], ny = normals[3 * j + 1], nz = normals[3 * j + 2];
        if (!Number.isFinite(nx)) continue;
        const q = target[j];
        const r = (mx[i] - q[0]) * nx + (my[i] - q[1]) * ny + (mz[i] - q[2]) * nz;
        const row = [-(my[i] - cm[1]) * nx + (mx[i] - cm[0]) * ny, nx, ny, nz];
        for (let u = 0; u < 4; u++) {
          b[u] -= row[u] * r;
          for (let v = 0; v < 4; v++) A[u][v] += row[u] * row[v];
        }
        used++;
      }
      const damp = PLANE_DAMPING * Math.max(A[0][0], A[1][1], A[2][2], A[3][3]);
      for (let u = 0; u < 4; u++) A[u][u] += damp;
      const x = used >= 4 ? solve4(A, b) : null;
      if (x && x.every(Number.isFinite)) {
        [dYaw, dtx, dty, dtz] = x;
        // Largest displacement this increment gives a kept point.
        let reach = 0;
        for (let k = 0; k < keep; k++) {
          const i = order[k];
          reach = Math.max(reach, Math.hypot(mx[i] - cm[0], my[i] - cm[1]));
        }
        step = Math.hypot(dtx, dty, dtz) + Math.abs(dYaw) * reach;
      }
    }
    // Apply the incremental rotation about `cm`, then translate.
    const cYaw = Math.cos(dYaw), sYaw = Math.sin(dYaw);

    // 3. Compose the increment (rotate about cm, then translate) into (yaw, t).
    //    New map: p → R(dYaw)·(R(yaw)·p + t − cm) + cm + d
    //           = R(yaw+dYaw)·p + [R(dYaw)·(t − cm) + cm + d]
    const txAdj = t[0] - cm[0], tyAdj = t[1] - cm[1];
    const newTx = cYaw * txAdj - sYaw * tyAdj + cm[0] + dtx;
    const newTy = sYaw * txAdj + cYaw * tyAdj + cm[1] + dty;
    const newTz = t[2] + dtz;
    yaw += dYaw;
    t = [newTx, newTy, newTz];

    // The plane metric converges on the size of its step: nearest-neighbour
    // distances between two samplings plateau while the pose still moves.
    if (normals ? step < tolerance : Math.abs(prevRms - rms) < tolerance) { converged = true; iter++; break; }
    prevRms = rms;
  }

  // Final residuals at the converged transform. `inlierFraction` counts source
  // points within `maxResidual` of a target point over the WHOLE cloud, so it
  // honestly discloses any rejected outliers even when the fit is otherwise
  // tight. `finalRms` mirrors the objective: over all points with no trimming,
  // or over the best-`trimFraction` (the inliers) when trimming — never diluted
  // by outliers the solve deliberately excluded.
  let inliers = 0;
  let within = 0;
  const maxD2 = maxResidual * maxResidual;
  moveSource();
  const finalD2 = d2s;
  for (let i = 0; i < n; i++) {
    nearestPoint(index, mx[i], my[i], mz[i]);
    const d2 = nearestState.d2;
    finalD2[i] = d2;
    if (d2 <= maxD2) inliers++;
    if (d2 <= gateD2) within++;
  }
  const inlierFraction = inliers / n;

  let finalRms: number;
  if (gated) {
    // The objective the gated solve minimised: the kept share of the pairs
    // inside the gate. No pair inside it leaves nothing to score.
    const inside = finalD2.filter((d2) => d2 <= gateD2).sort();
    if (inside.length === 0) {
      finalRms = Infinity;
    } else {
      const keep = trimming ? Math.max(1, Math.min(inside.length, Math.ceil(trimFraction * inside.length))) : inside.length;
      const s = new NeumaierSum();
      for (let i = 0; i < keep; i++) s.add(inside[i]);
      finalRms = Math.sqrt(s.total / keep);
    }
  } else if (trimming) {
    const sorted = finalD2.slice().sort();
    const keep = keepCount(sorted.length);
    const s = new NeumaierSum();
    for (let i = 0; i < keep; i++) s.add(sorted[i]);
    finalRms = Math.sqrt(s.total / keep);
  } else {
    const s = new NeumaierSum();
    for (let i = 0; i < n; i++) s.add(finalD2[i]);
    finalRms = Math.sqrt(s.total / n);
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
    ...(gated ? { overlapFraction: within / n } : {}),
  };
}
