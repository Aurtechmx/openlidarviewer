/**
 * supportCensus.ts
 *
 * How much of a frame was measured, how much was carried over, and how much the
 * renderer drew because it judged a gap safe to close.
 *
 * The Continuity Field is allowed to invent pixels between samples. The claim
 * that it only closes sampling gaps, and never paints a surface across ground
 * nothing was recorded on, is checkable rather than rhetorical: count the pixels
 * by where their colour came from. A frame where reconstruction has grown past a
 * thin seam between samples shows it here as a share, and a test can fail on
 * that number instead of on somebody's reading of a screenshot.
 *
 * This is the debug surface, not the normal view. The census is a property of
 * the drawn image, so it says nothing about the scene: a sparse scan legitimately
 * leaves more background than a dense one, and a share is only comparable
 * against the same view of the same data.
 *
 * Pure: no three.js, no framebuffer reads. The caller samples its own buffer and
 * hands over the tallies. Display only, and a support share is not a data
 * quality measure. It describes a rendering, and nothing derived from it may
 * reach picking, measurement, terrain, export or claim evidence.
 */
import type { SupportKind } from './microGap';

/** Pixel counts by where the colour came from. */
export interface SupportCensus {
  readonly direct: number;
  readonly accumulated: number;
  readonly reconstructed: number;
  readonly none: number;
}

/** An empty census. */
export const EMPTY_CENSUS: SupportCensus = {
  direct: 0,
  accumulated: 0,
  reconstructed: 0,
  none: 0,
};

/** Tally a run of pixels by support kind. */
export function censusOf(pixels: Iterable<SupportKind>): SupportCensus {
  const out = { direct: 0, accumulated: 0, reconstructed: 0, none: 0 };
  for (const p of pixels) out[p] += 1;
  return out;
}

/** Every pixel counted. */
export function totalPixels(c: SupportCensus): number {
  return c.direct + c.accumulated + c.reconstructed + c.none;
}

/**
 * The share of DRAWN pixels the renderer invented, in `[0, 1]`.
 *
 * Background is excluded from the denominator on purpose. Measured against the
 * whole frame, the same reconstruction would look negligible simply because the
 * camera was pulled back and most of the image was empty, which is the one
 * direction this number must not be easy to move. Against drawn pixels it
 * answers the question actually being asked: of the surface a viewer sees, how
 * much was not measured.
 *
 * A frame with nothing drawn has no share rather than a zero one, so an empty
 * view cannot be mistaken for a clean result.
 */
export function reconstructedShare(c: SupportCensus): number | null {
  const drawn = c.direct + c.accumulated + c.reconstructed;
  return drawn === 0 ? null : c.reconstructed / drawn;
}

/**
 * The share a frame may reconstruct before it stops being gap-closing.
 *
 * A starting value, not a measured one. Closing single-pixel seams between
 * splats touches a small minority of drawn pixels; a fifth of the visible
 * surface is well past a seam and into painting. The figure that belongs here
 * comes from real scenes at several densities.
 */
export const RECONSTRUCTION_SHARE_CEILING = 0.2;

/** Whether a frame stayed within {@link RECONSTRUCTION_SHARE_CEILING}. */
export function withinReconstructionCeiling(
  c: SupportCensus,
  ceiling: number = RECONSTRUCTION_SHARE_CEILING,
): boolean {
  const share = reconstructedShare(c);
  return share === null || share <= ceiling;
}
