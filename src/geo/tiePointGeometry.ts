/**
 * tiePointGeometry.ts — whether a correspondence set can determine a rigid
 * transform at all.
 *
 * Three correspondences are enough to fix a rigid transform only when they are
 * not collinear. Points strung along a line leave the rotation about that line
 * free, and points piled on one spot leave the whole rotation free. Horn's
 * method does not report that: it returns the dominant eigenvector of a matrix
 * whose leading eigenvalue is degenerate, which is a valid rotation chosen
 * arbitrarily from a family of them. The residual is then computed against the
 * arbitrary choice and comes back at or near zero, so the least determined
 * input a caller can supply is reported as the best fit it will ever see.
 *
 * That is the failure this module exists to prevent. The test is on the SHAPE
 * of each point set, not on the fit: a fit that cannot be wrong is not evidence
 * that it is right.
 *
 * Pure. No IO, no dependency on the solver.
 */

/** A point in the caller's own coordinate unit. */
export type Vec3 = readonly [number, number, number];

/** Why a correspondence set cannot determine a transform. */
export type TiePointDefect =
  | 'non-finite'
  | 'coincident'
  | 'collinear';

export interface TiePointGeometry {
  /** The defect found, or null when the set can determine a transform. */
  readonly defect: TiePointDefect | null;
  /**
   * How far the set departs from a line, as a fraction of its longest extent:
   * the ratio of the second to the first singular value of the centred scatter.
   * 0 is a straight line, and a well-spread set approaches 1. Zero for a set
   * with no extent at all, and NaN when the input is not finite.
   */
  readonly planarity: number;
}

/**
 * Departure from collinearity is measured as a RATIO rather than an absolute
 * distance because the input carries the caller's unit: a millimetre of spread
 * is decisive for a scanner-local set in metres and meaningless for a set in
 * survey feet across a county. A ratio is unit-free, so one threshold serves
 * every frame.
 *
 * The value is deliberately loose. It is not asking whether the geometry is
 * GOOD, which is a question about accuracy that this module cannot answer; it
 * is asking whether the geometry is DETERMINED, which is a question about rank.
 * A set that clears it can still register poorly, and the residual is what says
 * so.
 */
export const MIN_PLANARITY = 1e-6;

/** Mean of a point set. */
function centroid(p: readonly Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const q of p) {
    x += q[0];
    y += q[1];
    z += q[2];
  }
  return [x / p.length, y / p.length, z / p.length];
}

/**
 * Singular values of the centred scatter, largest first.
 *
 * The scatter is symmetric positive semi-definite, so its singular values are
 * its eigenvalues and the two largest are all this needs. They come from the
 * characteristic polynomial by the standard closed form for a symmetric 3x3,
 * which avoids pulling an iterative solver into a leaf module.
 */
function scatterSingularValues(p: readonly Vec3[]): [number, number, number] {
  const c = centroid(p);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const q of p) {
    const dx = q[0] - c[0], dy = q[1] - c[1], dz = q[2] - c[2];
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  // Eigenvalues of a symmetric 3x3 by the trigonometric closed form.
  const q = (xx + yy + zz) / 3;
  const a = xx - q, b = yy - q, c2 = zz - q;
  const p2 = (a * a + b * b + c2 * c2 + 2 * (xy * xy + xz * xz + yz * yz)) / 6;
  if (p2 <= 0) return [Math.max(q, 0), Math.max(q, 0), Math.max(q, 0)];
  const pp = Math.sqrt(p2);
  const d =
    (a * (b * c2 - yz * yz) - xy * (xy * c2 - yz * xz) + xz * (xy * yz - b * xz)) /
    (pp * pp * pp) /
    2;
  // Rounding can push `d` a hair outside the domain of acos; clamping keeps a
  // legitimately degenerate scatter from returning NaN and reading as bad input.
  const phi = Math.acos(Math.min(1, Math.max(-1, d))) / 3;
  const e1 = q + 2 * pp * Math.cos(phi);
  const e3 = q + 2 * pp * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  return [Math.max(e1, 0), Math.max(e2, 0), Math.max(e3, 0)];
}

/**
 * Classify one point set: can its shape determine a rotation?
 *
 * Only the two largest singular values are consulted. A set spanning a plane
 * (rank 2) fixes a rigid transform up to a reflection, and the solver's own
 * determinant handling settles that, so planarity alone is not a defect.
 */
export function tiePointGeometryOf(points: readonly Vec3[]): TiePointGeometry {
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
      return { defect: 'non-finite', planarity: Number.NaN };
    }
  }
  const [s1, s2] = scatterSingularValues(points);
  if (!(s1 > 0)) return { defect: 'coincident', planarity: 0 };
  const planarity = s2 / s1;
  if (planarity < MIN_PLANARITY) return { defect: 'collinear', planarity };
  return { defect: null, planarity };
}

/** The sentence a refusal carries, naming the set and what is wrong with it. */
export function describeTiePointDefect(which: 'source' | 'destination', d: TiePointDefect): string {
  switch (d) {
    case 'non-finite':
      return `tie-point registration: the ${which} points carry a coordinate that is not a finite number.`;
    case 'coincident':
      return `tie-point registration: the ${which} points are all at one location, so no rotation is determined.`;
    case 'collinear':
      return `tie-point registration: the ${which} points lie on a line, so rotation about that line is not determined and a residual near zero would not mean the fit is right.`;
  }
}
