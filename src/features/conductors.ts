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
 * It refuses non-linear inputs: a blob of vegetation or a wall is not a
 * conductor, so a low linearity (from the shared covariance descriptors) returns
 * ok:false rather than a plausible-looking sag. The sag is a MEASURED profile,
 * labelled as a parabolic fit, not a claim of a calibrated catenary. Pure and
 * deterministic.
 */

import { covarianceEigen, descriptorsFromEigen } from '../classification/geometryDescriptors';

export type Vec3 = readonly [number, number, number];

export interface ConductorFit {
  readonly ok: boolean;
  readonly reason?: string;
  /** Unit principal (span) direction. */
  readonly centerlineDir: Vec3;
  readonly linearity: number;
  /** Along-span length covered by the points. */
  readonly spanM: number;
  /** Maximum deflection below the straight chord between the span ends. */
  readonly sagM: number;
  /** RMS residual of the vertical profile fit. */
  readonly residualRms: number;
  readonly n: number;
}

const ZERO_DIR: Vec3 = [0, 0, 0];

/** Fit a conductor; `minLinearity` (default 0.9) is the floor below which the
 *  points are not accepted as a wire. */
export function fitConductor(points: readonly Vec3[], minLinearity = 0.9): ConductorFit {
  const n = points.length;
  const base = { centerlineDir: ZERO_DIR, linearity: 0, spanM: 0, sagM: 0, residualRms: Number.NaN, n };
  if (n < 5) return { ...base, ok: false, reason: 'TOO_FEW_POINTS' };

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
  // Along-span parameter s and vertical z per point.
  const s = new Array<number>(n), z = new Array<number>(n);
  let sMin = Infinity, sMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = points[i][0] - mx, dy = points[i][1] - my, dz = points[i][2] - mz;
    s[i] = dx * dir[0] + dy * dir[1] + dz * dir[2];
    z[i] = points[i][2];
    if (s[i] < sMin) sMin = s[i];
    if (s[i] > sMax) sMax = s[i];
  }
  const spanM = sMax - sMin;

  // Least-squares quadratic z ≈ A s² + B s + C.
  const q = fitQuadratic(s, z);
  if (!q) return { ...base, linearity, ok: false, reason: 'FIT_FAILED' };
  const [A, B, C] = q;
  let sse = 0;
  for (let i = 0; i < n; i++) { const e = A * s[i] * s[i] + B * s[i] + C - z[i]; sse += e * e; }
  const residualRms = Math.sqrt(sse / n);

  // Sag: max gap between the straight chord (ends) and the fitted curve.
  const zEnd0 = A * sMin * sMin + B * sMin + C;
  const zEnd1 = A * sMax * sMax + B * sMax + C;
  let sagM = 0;
  const K = 64;
  for (let k = 0; k <= K; k++) {
    const ss = sMin + ((sMax - sMin) * k) / K;
    const chord = zEnd0 + ((zEnd1 - zEnd0) * (ss - sMin)) / (spanM || 1);
    const curve = A * ss * ss + B * ss + C;
    const gap = chord - curve; // positive where the wire dips below the chord
    if (gap > sagM) sagM = gap;
  }

  return { ok: true, centerlineDir: [dir[0], dir[1], dir[2]], linearity, spanM, sagM, residualRms, n };
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
