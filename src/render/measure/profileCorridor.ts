/**
 * profileCorridor.ts
 *
 * The corridor membership test for a profile section, as one definition.
 *
 * `sampleProfile` reduces the corridor to a per-bin percentile series; the
 * section workbench keeps the individual returns instead. Both answer the
 * same question first: is this point inside the corridor, and at what
 * chainage. That question is answered here, so the two products cannot
 * drift apart.
 *
 * The corridor is a capsule. Membership is the distance to the FINITE
 * segment a -> b in the plane perpendicular to `up`: perpendicular distance
 * between the endpoints, radial distance from the nearer endpoint once the
 * chainage runs past either end. The boundary is inclusive, so a point at
 * exactly `band` is inside.
 *
 * The arithmetic below is the sampler's per-point walk term for term,
 * including the order of the multiplies and the early scalar reject, so the
 * two agree by construction rather than by tolerance.
 *
 * The algebraically equivalent form `(chainage - nearest)^2 + lateral^2` is
 * not interchangeable. Over 3.8e6 points placed within a few ulps of the
 * boundary the two forms differ by up to 1.45e-14 relative and return
 * opposite verdicts for 6.6e5 of them. Point positions are float32, whose
 * spacing is far coarser than that band, so a disagreement needs a point to
 * land inside it by chance; matching term for term removes the question
 * instead of bounding how often it arises.
 */
import type { ProfileFrame } from './profileGeometry';

/** Offsets into the scratch array {@link profileCorridorAccepts} writes. */
export const PROFILE_HIT_CHAINAGE = 0;
export const PROFILE_HIT_LATERAL = 1;
export const PROFILE_HIT_HEIGHT = 2;
/** Length of the scratch array a caller must supply. */
export const PROFILE_HIT_STRIDE = 3;

/**
 * Resolve the corridor half-width the sampler would use for this section.
 *
 * A null or absent width takes the automatic fraction of the section's
 * horizontal length; a supplied width is floored at zero. Mirrors the
 * resolution inside `sampleProfile` so a section and its derived series
 * never walk different corridors.
 */
export function resolveCorridorHalfWidth(
  horizontalLength: number,
  bandWidth: number | null | undefined,
  autoFraction: number,
): number {
  return bandWidth == null ? horizontalLength * autoFraction : Math.max(0, bandWidth);
}

/**
 * Test one point against the corridor, writing its chainage, signed lateral
 * offset and height into `out` when it is accepted.
 *
 * `out` is caller-owned and reused across points, so a scan of millions of
 * returns allocates nothing. Its contents are undefined when the result is
 * false.
 *
 * Returns false for a point with any non-finite coordinate. An organized
 * cloud marks invalid points NaN per the PCD spec, and no height can be read
 * off such a point.
 */
export function profileCorridorAccepts(
  frame: ProfileFrame,
  band: number,
  bandSq: number,
  px: number,
  py: number,
  pz: number,
  out: Float64Array,
): boolean {
  const u = frame.up;
  const aH = frame.horizontalAnchor;
  const hDir = frame.along;
  const horizontalLen = frame.horizontalLength;

  const height = px * u[0] + py * u[1] + pz * u[2];
  const dx = px - u[0] * height - aH[0];
  const dy = py - u[1] * height - aH[1];
  const dz = pz - u[2] * height - aH[2];

  const along = dx * hDir[0] + dy * hDir[1] + dz * hDir[2];
  if (!Number.isFinite(along)) return false;
  // Cheap scalar reject before the three multiplies below. A point whose
  // chainage is further than `band` past either end is further than `band`
  // from the segment, because |d| >= |along| for a projection.
  if (along < -band || along > horizontalLen + band) return false;

  const nearest = along < 0 ? 0 : along > horizontalLen ? horizontalLen : along;
  const pdx = dx - hDir[0] * nearest;
  const pdy = dy - hDir[1] * nearest;
  const pdz = dz - hDir[2] * nearest;
  const nearSq = pdx * pdx + pdy * pdy + pdz * pdz;
  if (nearSq > bandSq) return false;

  const lat = frame.lateral;
  out[PROFILE_HIT_CHAINAGE] = along;
  out[PROFILE_HIT_LATERAL] = dx * lat[0] + dy * lat[1] + dz * lat[2];
  out[PROFILE_HIT_HEIGHT] = height;
  return true;
}

/**
 * The bin an accepted chainage falls in, for a series of `samples` stations.
 *
 * Clamped at both ends so the capsule caps report into the end bins, matching
 * the sampler. Returns 0 when the section is horizontally degenerate.
 */
export function profileCorridorBin(
  chainage: number,
  horizontalLength: number,
  samples: number,
): number {
  if (!(horizontalLength > 0) || samples < 2) return 0;
  const binStep = horizontalLength / (samples - 1);
  let binIndex = Math.round(chainage / binStep);
  if (binIndex < 0) binIndex = 0;
  if (binIndex > samples - 1) binIndex = samples - 1;
  return binIndex;
}

/** Scratch array sized for {@link profileCorridorAccepts}. */
export function createProfileHitScratch(): Float64Array {
  return new Float64Array(PROFILE_HIT_STRIDE);
}

