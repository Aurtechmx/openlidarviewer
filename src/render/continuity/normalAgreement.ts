/**
 * normalAgreement.ts
 *
 * Whether the surface normals around a gap agree well enough for the gap to be
 * a gap rather than a corner.
 *
 * Depth alone cannot tell a sampling hole from a fold. Two points on either
 * side of a roof ridge sit at almost the same distance from the camera and pass
 * the depth test comfortably, and filling between them lays a flat patch across
 * the ridge. Where normals exist they settle it: the two sides face different
 * ways, and the fill is refused.
 *
 * Normals only ever refuse. They cannot turn a refusal into a fill, and that
 * asymmetry is the whole safety property: every fill still has to satisfy the
 * depth and support rules on its own, so adding a normals channel to a dataset
 * can only ever make the renderer more careful with it, never less.
 *
 * A cloud carrying no normals is the ordinary case, not a degraded one. Most
 * survey formats have none, the field has to work without them, so their
 * absence is silence rather than objection. A normal that is present but not a
 * usable direction is different: the channel claimed to know and did not, and
 * that refuses, on the same reasoning that a support score of NaN scores
 * nothing rather than everything.
 *
 * Normals are never computed here. Fitting one to a neighbourhood mid-frame
 * would be inventing the very thing being used to check an invention.
 *
 * Pure: no three.js, no GPU. Display only.
 */

/** A unit-ish surface direction. Not normalised by the caller necessarily. */
export interface Normal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * How far apart two normals may point and still count as one surface.
 *
 * Thirty degrees keeps a curved surface together while separating a wall from a
 * floor. A starting value: the angle that belongs here comes from real scans,
 * where scanner noise on a rough surface spreads normals more than geometry
 * does.
 */
export const MAX_NORMAL_ANGLE_DEG = 30;

/** Whether a normal is a usable direction rather than a placeholder. */
export function isUsableNormal(n: Normal | null | undefined): n is Normal {
  if (n === null || n === undefined) return false;
  if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) return false;
  return n.x * n.x + n.y * n.y + n.z * n.z > 0;
}

/**
 * Whether two normals point closely enough in the same direction.
 *
 * Compared by the cosine of the angle between them, so neither has to arrive
 * normalised. Opposite directions are not treated as agreement: a normal that
 * has been flipped describes a surface seen from the other side, and gluing
 * those together is exactly the fold this is meant to catch.
 */
export function normalsAgree(
  a: Normal,
  b: Normal,
  maxAngleDeg: number = MAX_NORMAL_ANGLE_DEG,
): boolean {
  const la = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  const lb = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
  if (!(la > 0) || !(lb > 0)) return false;
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return cos >= Math.cos((Math.max(0, maxAngleDeg) * Math.PI) / 180);
}

/**
 * Whether the normals around a candidate pixel object to filling it.
 *
 * `normals` are the supporting neighbours' normals, in the caller's order, with
 * `null` where a neighbour has none. Returns true when nothing objects, which
 * includes a cloud with no normals at all, so a caller that never has them
 * behaves as though this were not here.
 *
 * A present-but-unusable normal objects. The channel said it knew.
 */
export function normalsAllowFill(
  normals: readonly (Normal | null | undefined)[],
  maxAngleDeg: number = MAX_NORMAL_ANGLE_DEG,
): boolean {
  const known: Normal[] = [];
  for (const n of normals) {
    if (n === null || n === undefined) continue;
    if (!isUsableNormal(n)) return false;
    known.push(n);
  }
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      if (!normalsAgree(known[i], known[j], maxAngleDeg)) return false;
    }
  }
  return true;
}
