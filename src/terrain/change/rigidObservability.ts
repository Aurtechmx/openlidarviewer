/**
 * rigidObservability.ts — whether a point-to-plane rigid fit is determined by
 * the geometry it is given, decided before any damping.
 *
 * The epoch solver estimates four parameters per iteration: a yaw about world
 * up and a translation along x, y and z. Each correspondence contributes one
 * row `[lever, nx, ny, nz]` (the lever being the yaw's moment about the
 * sample centroid). The information matrix `Σ rowᵀ·row` says which of those
 * parameters the data can tell apart. A plane, sloped or flat, gives every row
 * the same normal: the matrix has rank one or two, and a shift along the slope
 * is indistinguishable from a change in height. Levenberg damping makes that
 * system solvable, not observable, so the test runs on the undamped matrix.
 *
 * Normalisation: the yaw row is divided by the RMS horizontal lever arm, so it
 * is dimensionless like the unit normals, and the matrix is divided by the
 * pair count. Two numbers are reported:
 *
 *   - `eigenRatio`: smallest over largest eigenvalue of the normalised 4×4
 *     matrix. Zero for any rank-deficient case.
 *   - `horizontalRatio`: for x and y, the information left on that direction
 *     after yaw, z and the other horizontal direction are eliminated
 *     (1 / (N⁻¹)ⱼⱼ), the smaller of the two over the largest eigenvalue. This is
 *     the statement that the horizontal directions are constrained
 *     independently of the vertical one. It is never smaller than
 *     `eigenRatio`, so it is reported for the record and gated for clarity.
 *
 * Both must reach {@link OBSERVABILITY_MIN_RATIO}. Pure; no DOM, no I/O.
 */

/**
 * Smallest accepted ratio of the weakest to the strongest constrained
 * direction (normalised information). 0.01 means every one of yaw, x, y and
 * z carries at least 1 % of the information of the best-constrained
 * direction. A plane gives 0 up to rounding and normal-estimation noise.
 */
export const OBSERVABILITY_MIN_RATIO = 0.01;

export interface RigidObservability {
  /** λmin / λmax of the normalised undamped information matrix (0..1). */
  readonly eigenRatio: number;
  /** Weakest horizontal direction's conditional information over λmax (0..1). */
  readonly horizontalRatio: number;
  /** The threshold both ratios were tested against. */
  readonly threshold: number;
  /** Both ratios reach the threshold. */
  readonly observable: boolean;
}

/** Eigenvalues of a symmetric 4×4 matrix by cyclic Jacobi rotations. */
export function symEigenvalues4(m: readonly (readonly number[])[]): number[] {
  const a = m.map((r) => r.slice());
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
      }
    }
  }
  return [a[0][0], a[1][1], a[2][2], a[3][3]];
}

/** Inverse of a 4×4 matrix by Gauss-Jordan with partial pivoting; null when singular. */
function invert4(m: readonly (readonly number[])[]): number[][] | null {
  const a = m.map((r, i) => [...r, ...[0, 1, 2, 3].map((j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (!(Math.abs(a[piv][c]) > 1e-300)) return null;
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c];
    for (let k = 0; k < 8; k++) a[c][k] /= d;
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r][c];
      for (let k = 0; k < 8; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((r) => r.slice(4));
}

/**
 * Test an undamped point-to-plane information matrix (rows and columns in the
 * order yaw, x, y, z; the yaw row in length units) for observability.
 *
 * @param info  Σ rowᵀ·row over the pairs, BEFORE any damping.
 * @param pairs Number of rows summed.
 * @param leverRms RMS horizontal lever arm of those rows (same length unit).
 */
export function rigidObservability(
  info: readonly (readonly number[])[],
  pairs: number,
  leverRms: number,
  threshold = OBSERVABILITY_MIN_RATIO,
): RigidObservability {
  const fail = { eigenRatio: 0, horizontalRatio: 0, threshold, observable: false };
  if (!(pairs >= 4) || !(leverRms > 0) || !Number.isFinite(leverRms)) return fail;
  const scale = [1 / leverRms, 1, 1, 1];
  const n = info.map((row, i) => row.map((v, j) => (v * scale[i] * scale[j]) / pairs));
  if (!n.every((r) => r.every(Number.isFinite))) return fail;
  const ev = symEigenvalues4(n);
  const max = Math.max(...ev);
  const min = Math.min(...ev);
  if (!(max > 0)) return fail;
  const eigenRatio = Math.max(0, min / max);
  const inv = eigenRatio > 0 ? invert4(n) : null;
  const horizontalRatio = inv && inv[1][1] > 0 && inv[2][2] > 0
    ? Math.min(1 / inv[1][1], 1 / inv[2][2]) / max
    : 0;
  return {
    eigenRatio,
    horizontalRatio,
    threshold,
    observable: eigenRatio >= threshold && horizontalRatio >= threshold,
  };
}
