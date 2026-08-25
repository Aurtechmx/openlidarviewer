/**
 * tiePointRegister.ts
 *
 * Rigid (rotation + translation, no scale) registration of one point set onto
 * another from labelled correspondences — the classic use is aligning two
 * scanner-local point clouds that share surveyed control targets but declare no
 * common CRS, so the CRS-based multi-layer mount cannot place them.
 *
 * The solver is Horn's closed-form absolute-orientation method (B.K.P. Horn,
 * 1987): it builds the 3×3 cross-covariance of the centred correspondences, packs
 * it into a symmetric 4×4 matrix whose largest-eigenvalue eigenvector is the unit
 * quaternion of the optimal rotation, then recovers the translation from the
 * centroids. Unlike a raw SVD polar factor it can never return a reflection, and
 * it is the least-squares optimum for any number of correspondences ≥ 3.
 *
 * Pure and dependency-free. Coordinates are consumed in whatever linear unit the
 * caller supplies (metres for a scanner-local E57); the residual comes back in
 * that same unit.
 */

export type Vec3 = readonly [number, number, number];

import { tiePointGeometryOf, describeTiePointDefect } from './tiePointGeometry';

export interface RigidTransform {
  /** Row-major 3×3 rotation, a proper rotation (determinant +1). */
  readonly rotation: readonly [number, number, number, number, number, number, number, number, number];
  /** Translation applied AFTER the rotation: `dst ≈ R · src + t`. */
  readonly translation: Vec3;
  /** Root-mean-square correspondence residual, in the input coordinate unit. */
  readonly rmsResidual: number;
}

/** Apply a {@link RigidTransform} to a point: `R · p + t`. */
export function applyRigid(tf: RigidTransform, p: Vec3): Vec3 {
  const r = tf.rotation;
  const t = tf.translation;
  return [
    r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + t[0],
    r[3] * p[0] + r[4] * p[1] + r[5] * p[2] + t[1],
    r[6] * p[0] + r[7] * p[1] + r[8] * p[2] + t[2],
  ];
}

function centroid(pts: readonly Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = pts.length;
  return [x / n, y / n, z / n];
}

/**
 * Largest-eigenvalue eigenvector of a symmetric 4×4, by shifted power iteration.
 * The shift `c` (a Gershgorin bound on the spectral radius) makes `N + c·I`
 * positive-definite so the iteration converges to the eigenvector of N's LARGEST
 * (most positive) eigenvalue — which is the quaternion Horn's construction wants.
 * The eigenvectors are unchanged by the shift.
 */
function dominantEigenvector4(N: number[][]): [number, number, number, number] {
  let c = 0;
  for (let i = 0; i < 4; i++) {
    let row = 0;
    for (let j = 0; j < 4; j++) row += Math.abs(N[i][j]);
    if (row > c) c = row;
  }
  const M = N.map((r, i) => r.map((v, j) => (i === j ? v + c : v)));
  // A start vector not orthogonal to the answer; the identity quaternion biases
  // toward a small rotation without forcing it.
  let v: [number, number, number, number] = [1, 0, 0, 0];
  for (let it = 0; it < 200; it++) {
    const w: [number, number, number, number] = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      w[i] = M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2] + M[i][3] * v[3];
    }
    const len = Math.hypot(w[0], w[1], w[2], w[3]) || 1;
    const next: [number, number, number, number] = [w[0] / len, w[1] / len, w[2] / len, w[3] / len];
    // Converged when the direction stops moving (sign-independent).
    const dot = Math.abs(next[0] * v[0] + next[1] * v[1] + next[2] * v[2] + next[3] * v[3]);
    v = next;
    if (dot > 1 - 1e-15) break;
  }
  return v;
}

/**
 * Register `src` onto `dst` from ordered correspondences (`src[i]` ↔ `dst[i]`).
 * Requires at least three non-collinear correspondences; throws otherwise. The
 * returned transform maps a source point into the destination frame as
 * `R · src + t`, and `rmsResidual` reports how well the correspondences fit.
 */
export function registerTiePoints(src: readonly Vec3[], dst: readonly Vec3[]): RigidTransform {
  if (src.length !== dst.length) {
    throw new Error('tie-point registration: source and destination counts differ.');
  }
  if (src.length < 3) {
    throw new Error('tie-point registration: at least three correspondences are required.');
  }
  // Shape before fit. Horn's method answers even where the answer is not
  // determined, and reports a residual near zero for it, so a caller who
  // trusted the residual would trust the least determined input most. See
  // `tiePointGeometry.ts`.
  for (const [which, points] of [
    ['source', src],
    ['destination', dst],
  ] as const) {
    const { defect } = tiePointGeometryOf(points);
    if (defect) throw new Error(describeTiePointDefect(which, defect));
  }

  const cs = centroid(src);
  const cd = centroid(dst);

  // 3×3 cross-covariance S = Σ (src−cs)(dst−cd)ᵀ.
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < src.length; i++) {
    const ax = src[i][0] - cs[0], ay = src[i][1] - cs[1], az = src[i][2] - cs[2];
    const bx = dst[i][0] - cd[0], by = dst[i][1] - cd[1], bz = dst[i][2] - cd[2];
    Sxx += ax * bx; Sxy += ax * by; Sxz += ax * bz;
    Syx += ay * bx; Syy += ay * by; Syz += ay * bz;
    Szx += az * bx; Szy += az * by; Szz += az * bz;
  }

  // Horn's symmetric 4×4 N.
  const N: number[][] = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];

  const [q0, qx, qy, qz] = dominantEigenvector4(N);

  // Unit quaternion → rotation matrix (row-major).
  const rotation: [number, number, number, number, number, number, number, number, number] = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - q0 * qz), 2 * (qx * qz + q0 * qy),
    2 * (qx * qy + q0 * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - q0 * qx),
    2 * (qx * qz - q0 * qy), 2 * (qy * qz + q0 * qx), 1 - 2 * (qx * qx + qy * qy),
  ];

  const translation: Vec3 = [
    cd[0] - (rotation[0] * cs[0] + rotation[1] * cs[1] + rotation[2] * cs[2]),
    cd[1] - (rotation[3] * cs[0] + rotation[4] * cs[1] + rotation[5] * cs[2]),
    cd[2] - (rotation[6] * cs[0] + rotation[7] * cs[1] + rotation[8] * cs[2]),
  ];

  const tf: RigidTransform = { rotation, translation, rmsResidual: 0 };

  let sse = 0;
  for (let i = 0; i < src.length; i++) {
    const m = applyRigid(tf, src[i]);
    const dx = m[0] - dst[i][0], dy = m[1] - dst[i][1], dz = m[2] - dst[i][2];
    sse += dx * dx + dy * dy + dz * dz;
  }
  return { rotation, translation, rmsResidual: Math.sqrt(sse / src.length) };
}
