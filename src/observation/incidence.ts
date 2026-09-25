/**
 * incidence.ts — incidence estimation shared by `olv.observation.strength`
 * (SPEC §2.5, the `incidence` component) and `olv.observation.coverage-gain`
 * (SPEC §5.6 OB-GAIN-03, the `inc_c` term).
 *
 * One home for three things both methods need, so they cannot drift apart:
 *
 *   - the local surface normal: the smallest eigenvalue's eigenvector of a
 *     voxel's mean-centred covariance, either from an index list
 *     ({@link fitNormalFromResidentPoints}) or from streamed moments
 *     ({@link VoxelMomentAccumulator});
 *   - the per-ray incidence cosine `|cos i|` between a unit ray direction and
 *     that normal, clamped to [0, 1] ({@link incidenceCosine});
 *   - the median over a list of cosines ({@link medianCosine}).
 *
 * A covariance-fit normal has no intrinsic sign, so every cosine here is the
 * absolute value of the dot product.
 *
 * The eigen solve is closed form (the trigonometric solution of the
 * characteristic cubic, then a cross product of two rows of `C − λ·I`) rather
 * than `src/math/symEig3.ts`'s Jacobi rotations: `symEig3` also sits in the
 * classification and registration chunks, and importing it here split it into
 * a shared chunk the entry chunk would have to list. `tests/observatoryCoverageGain.test.ts`
 * checks this solve against `symEig3` directly.
 *
 * Pure and DOM-free (OB-INT-01), with no imports.
 */

export type Vec3 = readonly [number, number, number];

/** Eigenvalues of a symmetric 3×3 matrix, descending, by the trigonometric solution of its characteristic cubic. */
export function symmetricEigenvalues3(cxx: number, cxy: number, cxz: number, cyy: number, cyz: number, czz: number): readonly [number, number, number] {
  const q = (cxx + cyy + czz) / 3;
  const off = cxy * cxy + cxz * cxz + cyz * cyz;
  const p2 = (cxx - q) ** 2 + (cyy - q) ** 2 + (czz - q) ** 2 + 2 * off;
  const p = Math.sqrt(p2 / 6);
  if (!(p > 0)) return [q, q, q];
  const bxx = (cxx - q) / p, byy = (cyy - q) / p, bzz = (czz - q) / p;
  const bxy = cxy / p, bxz = cxz / p, byz = cyz / p;
  const det = bxx * (byy * bzz - byz * byz) - bxy * (bxy * bzz - byz * bxz) + bxz * (bxy * byz - byy * bxz);
  const r = Math.min(1, Math.max(-1, det / 2));
  const phi = Math.acos(r) / 3;
  const l0 = q + 2 * p * Math.cos(phi);
  const l2 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [l0, 3 * q - l0 - l2, l2];
}

/**
 * The unit normal of a covariance given as its six unique entries: the
 * eigenvector of the smallest eigenvalue. `null` when the neighbourhood has
 * no plane: non-finite entries, all three eigenvalues equal, or a second
 * eigenvalue that is ~0 relative to the largest (collinear or coincident
 * points, where every direction perpendicular to the line is an equally
 * valid "smallest eigenvalue" vector). The sign is arbitrary.
 */
export function normalFromCovariance(cxx: number, cxy: number, cxz: number, cyy: number, cyz: number, czz: number): Vec3 | null {
  if (![cxx, cxy, cxz, cyy, cyz, czz].every(Number.isFinite)) return null;
  const [l0, l1, l2] = symmetricEigenvalues3(cxx, cxy, cxz, cyy, cyz, czz);
  const spread = Math.max(l0, 1e-12);
  if (l1 <= spread * 1e-9 || !(l0 > l2)) return null;
  // Rows of C − λ₂·I span the plane orthogonal to the normal; the largest
  // cross product of two of them is the best-conditioned normal direction.
  const r0: Vec3 = [cxx - l2, cxy, cxz];
  const r1: Vec3 = [cxy, cyy - l2, cyz];
  const r2: Vec3 = [cxz, cyz, czz - l2];
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let best: Vec3 = cross(r0, r1);
  let bestLen = Math.hypot(best[0], best[1], best[2]);
  for (const c of [cross(r0, r2), cross(r1, r2)]) {
    const len = Math.hypot(c[0], c[1], c[2]);
    if (len > bestLen) { best = c; bestLen = len; }
  }
  if (!(bestLen > 0) || !Number.isFinite(bestLen)) return null;
  return [best[0] / bestLen, best[1] / bestLen, best[2] / bestLen];
}

/**
 * Fits a unit surface normal from a voxel's own resident points (SPEC §2.5
 * names `symEig3`; this is the same smallest-eigenvalue eigenvector, from the
 * closed-form solve above).
 * `positions` is a flat `x,y,z,...` array; `indices` selects the records in
 * this voxel. `null` for fewer than 3 points or a degenerate neighbourhood.
 */
export function fitNormalFromResidentPoints(positions: Float32Array | Float64Array, indices: readonly number[]): Vec3 | null {
  const n = indices.length;
  if (n < 3) return null;
  let mx = 0, my = 0, mz = 0;
  for (const i of indices) {
    mx += positions[i * 3]!;
    my += positions[i * 3 + 1]!;
    mz += positions[i * 3 + 2]!;
  }
  mx /= n; my /= n; mz /= n;

  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
  for (const i of indices) {
    const dx = positions[i * 3]! - mx;
    const dy = positions[i * 3 + 1]! - my;
    const dz = positions[i * 3 + 2]! - mz;
    cxx += dx * dx; cxy += dx * dy; cxz += dx * dz;
    cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
  }
  const inv = 1 / n;
  return normalFromCovariance(cxx * inv, cxy * inv, cxz * inv, cyy * inv, cyz * inv, czz * inv);
}

/**
 * Streamed first and second moments per voxel key, for fitting normals over a
 * whole resident cloud in one pass without holding an index list per voxel.
 * Points are added in the caller's record order; each voxel's moments are
 * plain sums, so {@link VoxelMomentAccumulator.normals} is a deterministic
 * function of that order. Coordinates should be local (recentred) values so
 * the second moments do not lose precision to a large world offset.
 */
export class VoxelMomentAccumulator {
  private readonly moments = new Map<number, Float64Array>();

  /** Adds one point to voxel `key` (count, Σx, Σy, Σz, Σxx, Σxy, Σxz, Σyy, Σyz, Σzz). */
  add(key: number, x: number, y: number, z: number): void {
    let m = this.moments.get(key);
    if (m === undefined) {
      m = new Float64Array(10);
      this.moments.set(key, m);
    }
    m[0]! += 1;
    m[1]! += x; m[2]! += y; m[3]! += z;
    m[4]! += x * x; m[5]! += x * y; m[6]! += x * z;
    m[7]! += y * y; m[8]! += y * z; m[9]! += z * z;
  }

  /** One fitted normal per voxel with at least 3 points and a planar spread, keyed as added. */
  normals(): Map<number, Vec3> {
    const out = new Map<number, Vec3>();
    for (const [key, m] of this.moments) {
      const n = m[0]!;
      if (n < 3) continue;
      const mx = m[1]! / n, my = m[2]! / n, mz = m[3]! / n;
      const normal = normalFromCovariance(
        m[4]! / n - mx * mx, m[5]! / n - mx * my, m[6]! / n - mx * mz,
        m[7]! / n - my * my, m[8]! / n - my * mz, m[9]! / n - mz * mz,
      );
      if (normal !== null) out.set(key, normal);
    }
    return out;
  }
}

/** `|cos i|` between a unit ray direction and a unit surface normal, clamped to [0, 1]. */
export function incidenceCosine(direction: Vec3, normal: Vec3): number {
  const dot = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2];
  return Math.min(1, Math.max(0, Math.abs(dot)));
}

/** Median of a list of cosines (mean of the two middle values for an even count); `NaN` for an empty list. */
export function medianCosine(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The angle in degrees between a unit normal and the vertical axis (+Z or −Z, the normal's sign being arbitrary). */
export function normalAngleFromVerticalDegrees(normal: Vec3): number {
  return (Math.acos(Math.min(1, Math.abs(normal[2]))) * 180) / Math.PI;
}
