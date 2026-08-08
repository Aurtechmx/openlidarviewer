/**
 * geometryDescriptors.ts — multi-scale geometric descriptors from a point
 * neighbourhood's covariance eigenvalues.
 *
 * For a neighbourhood, form the 3×3 covariance of the mean-centred points, take
 * its eigenvalues l0 ≥ l1 ≥ l2 (normalised so e_i = l_i / Σl), and derive the
 * standard shape features: linearity, planarity, sphericity (scattering),
 * omnivariance, anisotropy, eigenentropy, surface variation (curvature), and
 * verticality (from the smallest-eigenvalue eigenvector, the surface normal).
 * These are the cues Classification 2.0 reasons over — a wire is linear, a roof
 * is planar-and-horizontal, a wall is planar-and-vertical, foliage is scattered.
 *
 * Pure and deterministic. Descriptors are DERIVED, never a class label — the
 * classifier decides; this only measures shape. Returns null for a neighbourhood
 * too small to have a shape (< 3 points).
 */

import { symEig3, type SymEig3 } from '../math/symEig3';

export interface GeoDescriptors {
  readonly linearity: number;
  readonly planarity: number;
  readonly sphericity: number;
  readonly omnivariance: number;
  readonly anisotropy: number;
  readonly eigenentropy: number;
  /** l2 / (l0+l1+l2) — low on a clean surface, high on rough/scattered points. */
  readonly surfaceVariation: number;
  /** 1 − |n·ẑ|: ~0 for a horizontal surface (normal up), ~1 for a vertical one. */
  readonly verticality: number;
  readonly neighborCount: number;
}

/** Mean-centred covariance eigen-decomposition of a neighbourhood, or null. */
export function covarianceEigen(
  positions: Float32Array | ReadonlyArray<number>,
  ids: ReadonlyArray<number>,
): SymEig3 | null {
  const n = ids.length;
  if (n < 3) return null;
  let mx = 0, my = 0, mz = 0;
  for (const i of ids) { mx += positions[i * 3]; my += positions[i * 3 + 1]; mz += positions[i * 3 + 2]; }
  mx /= n; my /= n; mz /= n;
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
  for (const i of ids) {
    const dx = positions[i * 3] - mx, dy = positions[i * 3 + 1] - my, dz = positions[i * 3 + 2] - mz;
    cxx += dx * dx; cxy += dx * dy; cxz += dx * dz; cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
  }
  const inv = 1 / n;
  return symEig3(cxx * inv, cxy * inv, cxz * inv, cyy * inv, cyz * inv, czz * inv);
}

/** Derive the shape features from an eigen-decomposition. */
export function descriptorsFromEigen(eig: SymEig3, neighborCount: number): GeoDescriptors {
  const [l0, l1, l2] = eig.values.map((v) => Math.max(0, v)) as [number, number, number];
  const sum = l0 + l1 + l2;
  if (sum <= 0) {
    return { linearity: 0, planarity: 0, sphericity: 0, omnivariance: 0, anisotropy: 0, eigenentropy: 0, surfaceVariation: 0, verticality: 0, neighborCount };
  }
  const e0 = l0 / sum, e1 = l1 / sum, e2 = l2 / sum;
  const denom = e0 > 0 ? e0 : 1;
  const ent = -(safeEntropy(e0) + safeEntropy(e1) + safeEntropy(e2));
  // Normal = eigenvector of the SMALLEST eigenvalue (index 2, values sorted desc).
  const nz = Math.abs(eig.vectors[2][2]);
  return {
    linearity: (e0 - e1) / denom,
    planarity: (e1 - e2) / denom,
    sphericity: e2 / denom,
    omnivariance: Math.cbrt(e0 * e1 * e2),
    anisotropy: (e0 - e2) / denom,
    eigenentropy: ent,
    surfaceVariation: e2, // e2 = l2/Σl since e's sum to 1
    verticality: 1 - Math.min(1, nz),
    neighborCount,
  };
}

/** Descriptors for one neighbourhood (positions + neighbour ids), or null. */
export function descriptorsForNeighborhood(
  positions: Float32Array | ReadonlyArray<number>,
  ids: ReadonlyArray<number>,
): GeoDescriptors | null {
  const eig = covarianceEigen(positions, ids);
  return eig ? descriptorsFromEigen(eig, ids.length) : null;
}

function safeEntropy(e: number): number {
  return e > 0 ? e * Math.log(e) : 0;
}
