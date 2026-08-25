/**
 * conductors.ts — fit a power-line conductor's centreline and sag (Phase 6).
 *
 * Candidate conductor points (class-14 wire) form a thin, sagging arc. This fits
 * the horizontal centreline as the point set's principal direction, projects the
 * points onto it to get an along-span parameter, and fits the vertical profile as
 * a quadratic in that parameter — a parabola, the standard small-sag
 * approximation to a catenary. It reports the span, the sag (maximum deflection
 * below the straight chord between the ends), and the fit residual.
 *
 * The vertical is the caller's `up` axis, not index 2. A source whose frame is
 * not Z-up would otherwise have its sag read off an axis that is not up, and the
 * span read across one that is; the section-line frame in profileGeometry is the
 * same seam, and this module reuses it rather than restating the shortcut.
 *
 * Span and sag are in the INPUT'S OWN unit, whatever that is, which is why the
 * fields carry no metric name. The metric twin is emitted one layer up, and only
 * when the linear unit is known.
 *
 * It refuses non-linear inputs: a blob of vegetation or a wall is not a
 * conductor, so a low linearity (from the shared covariance descriptors) returns
 * ok:false rather than a plausible-looking sag. The sag is a MEASURED profile,
 * labelled as a parabolic fit, not a claim of a calibrated catenary. Pure and
 * deterministic.
 */

import { covarianceEigen, descriptorsFromEigen } from '../classification/geometryDescriptors';
import {
  buildProfileFrame,
  projectPointToProfile,
  DEGENERATE_HORIZONTAL_LENGTH,
} from '../render/measure/profileGeometry';

export type Vec3 = readonly [number, number, number];

export interface ConductorFit {
  readonly ok: boolean;
  readonly reason?: string;
  /** Unit principal (span) direction. */
  readonly centerlineDir: Vec3;
  readonly linearity: number;
  /** Along-span length covered by the points, in the input's own unit. */
  readonly spanSource: number;
  /**
   * Maximum deflection below the straight chord between the span ends, measured
   * along `up`, in the input's own unit.
   */
  readonly sagSource: number;
  /** RMS residual of the vertical profile fit, in the input's own unit. */
  readonly residualRmsSource: number;
  readonly n: number;
}

const ZERO_DIR: Vec3 = [0, 0, 0];

/**
 * Fit a conductor. `up` is the frame's vertical axis and is required: a wrong
 * vertical turns sag into a number that is not sag, so there is no default worth
 * guessing. `minLinearity` (default 0.9) is the floor below which the points are
 * not accepted as a wire.
 */
export function fitConductor(points: readonly Vec3[], up: Vec3, minLinearity = 0.9): ConductorFit {
  const n = points.length;
  const base = {
    centerlineDir: ZERO_DIR, linearity: 0, spanSource: 0, sagSource: 0,
    residualRmsSource: Number.NaN, n,
  };
  if (n < 5) return { ...base, ok: false, reason: 'TOO_FEW_POINTS' };
  // A zero / non-finite up axis has no vertical to project onto. Refuse it here
  // rather than let it normalise to [0,0,0] and report a flat, sagless wire.
  const upLen = Math.hypot(up[0], up[1], up[2]);
  if (!Number.isFinite(upLen) || upLen === 0) return { ...base, ok: false, reason: 'DEGENERATE_UP' };

  const flat: number[] = new Array(n * 3);
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) {
    flat[i * 3] = points[i][0]; flat[i * 3 + 1] = points[i][1]; flat[i * 3 + 2] = points[i][2];
    mx += points[i][0]; my += points[i][1]; mz += points[i][2];
  }
  mx /= n; my /= n; mz /= n;
  const eig = covarianceEigen(flat, Array.from({ length: n }, (_, i) => i));
  if (!eig) return { ...base, ok: false, reason: 'DEGENERATE' };
  const linearity = descriptorsFromEigen(eig, n).linearity;
  if (linearity < minLinearity) return { ...base, linearity, ok: false, reason: 'NOT_LINEAR' };

  const dir = eig.vectors[0]; // principal (span) direction
  // The two extreme points along the principal direction are the span's ends;
  // they define the section line the profile is measured against.
  let tMin = Infinity, tMax = -Infinity, iMin = 0, iMax = 0;
  for (let i = 0; i < n; i++) {
    const dx = points[i][0] - mx, dy = points[i][1] - my, dz = points[i][2] - mz;
    const t = dx * dir[0] + dy * dir[1] + dz * dir[2];
    if (t < tMin) { tMin = t; iMin = i; }
    if (t > tMax) { tMax = t; iMax = i; }
  }
  const end0 = points[iMin], end1 = points[iMax];
  const frame = buildProfileFrame(
    [end0[0], end0[1], end0[2]],
    [end1[0], end1[1], end1[2]],
    [up[0], up[1], up[2]],
  );
  // A span with no plan extent is a vertical drop, not a conductor run: there is
  // no chainage axis to fit a profile against.
  if (!(frame.horizontalLength > DEGENERATE_HORIZONTAL_LENGTH)) {
    return { ...base, linearity, ok: false, reason: 'NO_HORIZONTAL_EXTENT' };
  }
  // Chainage along the section line and height along `up`, per point.
  const s = new Array<number>(n), z = new Array<number>(n);
  let sMin = Infinity, sMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const proj = projectPointToProfile(frame, [points[i][0], points[i][1], points[i][2]]);
    s[i] = proj.chainage;
    z[i] = proj.height;
    if (s[i] < sMin) sMin = s[i];
    if (s[i] > sMax) sMax = s[i];
  }
  const spanSource = sMax - sMin;

  // Least-squares quadratic z ≈ A s² + B s + C.
  const q = fitQuadratic(s, z);
  if (!q) return { ...base, linearity, ok: false, reason: 'FIT_FAILED' };
  const [A, B, C] = q;
  let sse = 0;
  for (let i = 0; i < n; i++) { const e = A * s[i] * s[i] + B * s[i] + C - z[i]; sse += e * e; }
  const residualRmsSource = Math.sqrt(sse / n);

  // Sag: max gap between the straight chord (ends) and the fitted curve.
  const zEnd0 = A * sMin * sMin + B * sMin + C;
  const zEnd1 = A * sMax * sMax + B * sMax + C;
  let sagSource = 0;
  const K = 64;
  for (let k = 0; k <= K; k++) {
    const ss = sMin + ((sMax - sMin) * k) / K;
    const chord = zEnd0 + ((zEnd1 - zEnd0) * (ss - sMin)) / (spanSource || 1);
    const curve = A * ss * ss + B * ss + C;
    const gap = chord - curve; // positive where the wire dips below the chord
    if (gap > sagSource) sagSource = gap;
  }

  return {
    ok: true, centerlineDir: [dir[0], dir[1], dir[2]], linearity,
    spanSource, sagSource, residualRmsSource, n,
  };
}

/** Solve least-squares [A,B,C] for z ≈ A x² + B x + C via 3×3 normal equations. */
function fitQuadratic(x: readonly number[], y: readonly number[]): [number, number, number] | null {
  let s0 = x.length, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i], x2 = xi * xi;
    s1 += xi; s2 += x2; s3 += x2 * xi; s4 += x2 * x2;
    t0 += y[i]; t1 += y[i] * xi; t2 += y[i] * x2;
  }
  // Matrix [[s4,s3,s2],[s3,s2,s1],[s2,s1,s0]] · [A,B,C] = [t2,t1,t0].
  const m = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]];
  const b = [t2, t1, t0];
  return solve3(m, b);
}
function solve3(m: number[][], b: number[]): [number, number, number] | null {
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det) < 1e-12) return null;
  const inv = (r: number, c: number): number => {
    const a = [[0, 1, 2].filter((i) => i !== r), [0, 1, 2].filter((i) => i !== c)];
    const sub = a[1].map((cc) => a[0].map((rr) => m[rr][cc]));
    const minor = sub[0][0] * sub[1][1] - sub[0][1] * sub[1][0];
    return (((r + c) % 2 === 0) ? 1 : -1) * minor / det;
  };
  // x = inv(m)^T · b  (cofactor/det gives inverse transpose entries above).
  return [
    inv(0, 0) * b[0] + inv(1, 0) * b[1] + inv(2, 0) * b[2],
    inv(0, 1) * b[0] + inv(1, 1) * b[1] + inv(2, 1) * b[2],
    inv(0, 2) * b[0] + inv(1, 2) * b[1] + inv(2, 2) * b[2],
  ];
}
