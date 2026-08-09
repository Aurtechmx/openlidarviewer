/**
 * rigidSolve.ts — closed-form 6-DOF rigid registration from point
 * correspondences (Kabsch / Horn), scale fixed at 1.
 *
 * Given N source points and their N corresponding target points, finds the
 * rotation R and translation t that best map source → target in the
 * least-squares sense: minimise Σ |R·pᵢ + t − qᵢ|². The rotation comes from the
 * 3×3 cross-covariance via a polar decomposition built on the shared symmetric
 * eigensolver (symEig3), with the standard determinant fix so the result is a
 * proper rotation, never a reflection.
 *
 * It refuses rather than guesses: fewer than 3 correspondences, or a degenerate
 * (near-collinear / near-coincident) point set that cannot pin all three axes,
 * returns ok:false with a reason. Pure and deterministic — the numerical spine
 * for the registration phase; ICP and tie-point flows build on it.
 */

import { symEig3 } from '../math/symEig3';

export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [Vec3, Vec3, Vec3];

export interface RigidResult {
  /** Rotation (row-major 3×3), identity when !ok. */
  readonly R: Mat3;
  /** Translation applied after rotation. */
  readonly t: Vec3;
  /** RMS residual of R·p+t vs q over the correspondences (NaN when !ok). */
  readonly rmse: number;
  readonly n: number;
  readonly ok: boolean;
  /** UPPER_SNAKE reason when refused. */
  readonly reason?: string;
}

const IDENT: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * Solve for the rigid transform mapping `source[i]` onto `target[i]`.
 * `minCorrespondences` (default 3) is the floor below which 6-DOF is
 * under-determined.
 */
export function rigidSolve(
  source: readonly Vec3[],
  target: readonly Vec3[],
  minCorrespondences = 3,
  /**
   * Optional fit-quality gate: the maximum acceptable RMS residual (same linear
   * unit as the coordinates). A closed-form solve always returns SOME transform,
   * even for mismatched or garbage correspondences; without a gate `ok:true`
   * means only "a transform was computed", not "the fit is good". When this is a
   * finite positive number and the residual exceeds it, the result is `ok:false`
   * with reason `FIT_RMSE_EXCEEDED` — the transform and rmse are still returned
   * so the caller can inspect them. Omitted ⇒ no fit gate (unchanged behaviour).
   */
  maxRmse?: number,
): RigidResult {
  // Correspondences must pair one-to-one: a length mismatch is a caller bug, not
  // a set to silently truncate to the shorter of the two (which would fit points
  // to the wrong partners).
  if (source.length !== target.length) {
    return { R: IDENT, t: [0, 0, 0], rmse: NaN, n: 0, ok: false, reason: 'CORRESPONDENCE_COUNT_MISMATCH' };
  }
  const n = source.length;
  if (n < Math.max(3, minCorrespondences)) {
    return { R: IDENT, t: [0, 0, 0], rmse: NaN, n, ok: false, reason: 'TOO_FEW_CORRESPONDENCES' };
  }
  // Non-finite coordinates would poison the centroid and covariance; reject
  // rather than emit a transform built from NaN/Inf.
  for (let i = 0; i < n; i++) {
    const p = source[i], q = target[i];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2]) ||
        !Number.isFinite(q[0]) || !Number.isFinite(q[1]) || !Number.isFinite(q[2])) {
      return { R: IDENT, t: [0, 0, 0], rmse: NaN, n, ok: false, reason: 'NON_FINITE_CORRESPONDENCE' };
    }
  }

  // Centroids.
  const pc = centroid(source, n);
  const qc = centroid(target, n);

  // Cross-covariance H = Σ (p−p̄)(q−q̄)ᵀ, and the source spread (for degeneracy).
  const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let srcSpread = 0;
  for (let i = 0; i < n; i++) {
    const px = source[i][0] - pc[0], py = source[i][1] - pc[1], pz = source[i][2] - pc[2];
    const qx = target[i][0] - qc[0], qy = target[i][1] - qc[1], qz = target[i][2] - qc[2];
    H[0][0] += px * qx; H[0][1] += px * qy; H[0][2] += px * qz;
    H[1][0] += py * qx; H[1][1] += py * qy; H[1][2] += py * qz;
    H[2][0] += pz * qx; H[2][1] += pz * qy; H[2][2] += pz * qz;
    srcSpread += px * px + py * py + pz * pz;
  }
  if (srcSpread <= 1e-12) {
    return { R: IDENT, t: [0, 0, 0], rmse: NaN, n, ok: false, reason: 'DEGENERATE_SOURCE' };
  }
  const Hm = H as unknown as Mat3;

  // Polar decomposition of H via eigendecomposition of S = HᵀH.
  // H = U Σ Vᵀ ⟹ S = V Σ² Vᵀ ; U = H V Σ⁻¹ ; R = V Uᵀ (with the det fix).
  const S = matTmatMul(Hm); // HᵀH (symmetric)
  const eig = symEig3(S[0][0], S[0][1], S[0][2], S[1][1], S[1][2], S[2][2]);
  const sigma = eig.values.map((v) => Math.sqrt(Math.max(0, v))) as [number, number, number];
  // The two largest singular values must be non-trivial to fix all three axes;
  // a near-planar/near-linear correspondence set cannot determine a unique R.
  if (sigma[1] < 1e-6 * (sigma[0] || 1)) {
    return { R: IDENT, t: [0, 0, 0], rmse: NaN, n, ok: false, reason: 'DEGENERATE_GEOMETRY' };
  }
  const V: Mat3 = eig.vectors; // columns are v0,v1,v2 → but symEig3 returns rows aligned to values
  // Build V as a matrix whose COLUMNS are the eigenvectors.
  const Vc: Mat3 = [
    [V[0][0], V[1][0], V[2][0]],
    [V[0][1], V[1][1], V[2][1]],
    [V[0][2], V[1][2], V[2][2]],
  ];
  // U columns: uₖ = H vₖ / σₖ (guard σ→0 with the third axis reconstructed).
  const u0 = scale(matVec(Hm, eig.vectors[0]), 1 / (sigma[0] || 1));
  const u1 = scale(matVec(Hm, eig.vectors[1]), 1 / (sigma[1] || 1));
  let u2 = sigma[2] > 1e-9 ? scale(matVec(Hm, eig.vectors[2]), 1 / sigma[2]) : cross(u0, u1);
  // U columns → matrix.
  let Uc: Mat3 = [[u0[0], u1[0], u2[0]], [u0[1], u1[1], u2[1]], [u0[2], u1[2], u2[2]]];
  // R = V Uᵀ.
  let R = matMul(Vc, transpose(Uc));
  // Determinant fix: a reflection (det<0) is corrected by flipping the smallest
  // singular direction of U.
  if (det3(R) < 0) {
    u2 = [-u2[0], -u2[1], -u2[2]];
    Uc = [[u0[0], u1[0], u2[0]], [u0[1], u1[1], u2[1]], [u0[2], u1[2], u2[2]]];
    R = matMul(Vc, transpose(Uc));
  }

  const t: Vec3 = [
    qc[0] - (R[0][0] * pc[0] + R[0][1] * pc[1] + R[0][2] * pc[2]),
    qc[1] - (R[1][0] * pc[0] + R[1][1] * pc[1] + R[1][2] * pc[2]),
    qc[2] - (R[2][0] * pc[0] + R[2][1] * pc[1] + R[2][2] * pc[2]),
  ];

  // Residual.
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const rp = matVec(R, source[i]);
    const dx = rp[0] + t[0] - target[i][0];
    const dy = rp[1] + t[1] - target[i][1];
    const dz = rp[2] + t[2] - target[i][2];
    sse += dx * dx + dy * dy + dz * dz;
  }
  const rmse = Math.sqrt(sse / n);
  // Fit-quality gate: a solved transform whose residual exceeds the caller's
  // tolerance is refused, so `ok:true` cannot stand for a garbage fit.
  if (Number.isFinite(maxRmse) && (maxRmse as number) > 0 && rmse > (maxRmse as number)) {
    return { R, t, rmse, n, ok: false, reason: 'FIT_RMSE_EXCEEDED' };
  }
  return { R, t, rmse, n, ok: true };
}

// ── small 3×3 helpers ────────────────────────────────────────────────────────
function centroid(pts: readonly Vec3[], n: number): Vec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) { x += pts[i][0]; y += pts[i][1]; z += pts[i][2]; }
  return [x / n, y / n, z / n];
}
function matVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}
function matMul(a: Mat3, b: Mat3): Mat3 {
  const out: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  }
  return out as unknown as Mat3;
}
function transpose(m: Mat3): Mat3 {
  return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
}
/** HᵀH for a 3×3 H. */
function matTmatMul(h: Mat3): Mat3 {
  return matMul(transpose(h), h);
}
function det3(m: Mat3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}
function scale(v: Vec3, s: number): Vec3 { return [v[0] * s, v[1] * s, v[2] * s]; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
