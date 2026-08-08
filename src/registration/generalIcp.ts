/**
 * generalIcp.ts — trimmed iterative closest point (ICP) registration.
 *
 * Aligns a source cloud onto a target cloud without given correspondences: each
 * iteration pairs every (currently transformed) source point with its nearest
 * target point via the spatial hash, drops the worst `trimFraction` of pairs by
 * distance (so a partial overlap or gross outliers do not drag the fit), solves
 * the new absolute pose on the survivors with rigidSolve, and stops when the RMS
 * stops improving.
 *
 * It refuses rather than reports a confident-looking wrong answer: too few
 * points, or an inlier overlap below `minInlierFraction`, returns ok:false with
 * a reason. The result carries the final transform, RMSE, iteration count,
 * convergence flag and the achieved inlier fraction — the honesty signals a
 * caller needs before trusting an alignment. Pure and deterministic.
 */

import { SpatialHash3d } from '../classification/spatialHash3d';
import { rigidSolve, type Vec3, type Mat3 } from './rigidSolve';

export interface IcpOptions {
  readonly maxIterations?: number;
  /** Fraction of worst-distance pairs discarded each iteration (0..1). */
  readonly trimFraction?: number;
  /** Only pairs within this distance are considered a match. */
  readonly searchRadius?: number;
  /** Stop when the RMSE improves by less than this between iterations. */
  readonly convergenceTol?: number;
  /** Refuse if fewer than this fraction of source points find a match. */
  readonly minInlierFraction?: number;
}

export interface IcpResult {
  readonly R: Mat3;
  readonly t: Vec3;
  readonly rmse: number;
  readonly iterations: number;
  readonly converged: boolean;
  readonly inlierFraction: number;
  readonly ok: boolean;
  readonly reason?: string;
}

const IDENT: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export function generalIcp(
  source: readonly Vec3[],
  target: readonly Vec3[],
  opts: IcpOptions = {},
): IcpResult {
  const maxIterations = opts.maxIterations ?? 40;
  const trimFraction = clamp(opts.trimFraction ?? 0.2, 0, 0.9);
  const searchRadius = opts.searchRadius && opts.searchRadius > 0 ? opts.searchRadius : autoRadius(target);
  const tol = opts.convergenceTol ?? 1e-6;
  const minInlier = opts.minInlierFraction ?? 0.3;

  if (source.length < 3 || target.length < 3) {
    return fail('TOO_FEW_POINTS');
  }

  const hash = new SpatialHash3d(flatten(target), searchRadius);
  let R: Mat3 = IDENT;
  let t: Vec3 = [0, 0, 0];
  let prevRmse = Infinity;
  let rmse = Infinity;
  let inlierFraction = 0;
  let converged = false;
  let iter = 0;

  for (; iter < maxIterations; iter++) {
    // Pair each transformed source point with its nearest target within radius.
    const src: Vec3[] = [];
    const dst: Vec3[] = [];
    const dists: number[] = [];
    for (const p of source) {
      const tp = applyRt(R, t, p);
      const near = hash.queryRadius(tp[0], tp[1], tp[2], searchRadius);
      let bestId = -1, bestD2 = Infinity;
      for (const id of near) {
        const q = target[id];
        const d2 = sq(q[0] - tp[0]) + sq(q[1] - tp[1]) + sq(q[2] - tp[2]);
        if (d2 < bestD2) { bestD2 = d2; bestId = id; }
      }
      if (bestId >= 0) { src.push(p); dst.push(target[bestId]); dists.push(Math.sqrt(bestD2)); }
    }
    inlierFraction = src.length / source.length;
    if (src.length < 3) return { ...fail('NO_OVERLAP'), iterations: iter, inlierFraction };

    // Trim the worst pairs by distance.
    const keep = trim(src, dst, dists, trimFraction);
    if (keep.src.length < 3) return { ...fail('NO_OVERLAP'), iterations: iter, inlierFraction };

    // Correspondences are found with the current pose, but the solve uses the
    // ORIGINAL source points, so the fit is the new ABSOLUTE pose — replace the
    // running transform with it rather than composing.
    const fit = rigidSolve(keep.src, keep.dst);
    if (!fit.ok) return { ...fail(fit.reason ?? 'SOLVE_FAILED'), iterations: iter, inlierFraction };
    R = fit.R;
    t = fit.t;
    rmse = fit.rmse;
    if (Math.abs(prevRmse - rmse) < tol) { converged = true; iter++; break; }
    prevRmse = rmse;
  }

  if (inlierFraction < minInlier) {
    return { R, t, rmse, iterations: iter, converged, inlierFraction, ok: false, reason: 'LOW_OVERLAP' };
  }
  return { R, t, rmse, iterations: iter, converged, inlierFraction, ok: true };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function fail(reason: string): IcpResult {
  return { R: IDENT, t: [0, 0, 0], rmse: NaN, iterations: 0, converged: false, inlierFraction: 0, ok: false, reason };
}
function trim(src: Vec3[], dst: Vec3[], dists: number[], frac: number): { src: Vec3[]; dst: Vec3[] } {
  if (frac <= 0) return { src, dst };
  const order = dists.map((d, i) => [d, i] as const).sort((a, b) => a[0] - b[0]);
  const keepN = Math.max(3, Math.floor(order.length * (1 - frac)));
  const outS: Vec3[] = [], outD: Vec3[] = [];
  for (let k = 0; k < keepN; k++) { const i = order[k][1]; outS.push(src[i]); outD.push(dst[i]); }
  return { src: outS, dst: outD };
}
function autoRadius(pts: readonly Vec3[]): number {
  // Bounding-box diagonal / cube-root(n) ≈ mean spacing; a few × that as radius.
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (const p of pts) {
    if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
    if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
    if (p[2] < minz) minz = p[2]; if (p[2] > maxz) maxz = p[2];
  }
  const diag = Math.hypot(maxx - minx, maxy - miny, maxz - minz) || 1;
  return (5 * diag) / Math.cbrt(pts.length);
}
function flatten(pts: readonly Vec3[]): number[] {
  const a: number[] = new Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) { a[i * 3] = pts[i][0]; a[i * 3 + 1] = pts[i][1]; a[i * 3 + 2] = pts[i][2]; }
  return a;
}
function applyRt(R: Mat3, t: Vec3, p: Vec3): Vec3 {
  return [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2],
  ];
}
function sq(x: number): number { return x * x; }
function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
