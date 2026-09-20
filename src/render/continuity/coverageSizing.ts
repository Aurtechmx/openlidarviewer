/**
 * coverageSizing.ts — how large a point is drawn so the surface reads as one.
 *
 * A point cloud drawn at a fixed size shows the sampling rather than the
 * surface: where samples are further apart than the dot that represents them,
 * the background comes through and a wall reads as a screen door. Growing the
 * dot until it meets its neighbour closes that without inventing anything,
 * because the space between two samples of one surface is a gap in the
 * SAMPLING, not a gap in the evidence.
 *
 * ── THE FOUR SPACINGS, AND WHY THEY MUST NOT MEET ───────────────────────────
 * The programme names four and they are different quantities:
 *
 *   render spacing     how far apart neighbouring samples land ON SCREEN,
 *                      in pixels, for one camera. Changes when the camera
 *                      moves and means nothing without one.
 *   scientific density a measured property of the scan, in points per square
 *                      metre, computed for a stated region and reported with
 *                      its method.
 *   source density     what the file holds, before any budget reduced it.
 *   resident density   what is in memory now, which a streaming budget and an
 *                      eviction policy both move.
 *
 * Only the first is in this file, and this file is the only one that produces
 * it. The rule the programme states is that display spacing must never be used
 * as a density estimate, and the structural guarantee here is stronger than a
 * comment: no function in this module takes a point count or an area, and none
 * returns one. A density cannot be assembled from what is on offer, so the
 * mistake cannot be made by accident, only by writing a different module.
 *
 * Presentation only. A drawn size changes which pixels are lit; it changes no
 * position, no count and no measured quantity, and nothing here may reach
 * picking, measurement, terrain, export or claim evidence.
 *
 * Pure: no GPU, no DOM, no camera object. The projection arrives as a focal
 * length in pixels, which the caller already has.
 */
import { projectedSpacingPx } from '../streaming/coverageBudget';

/**
 * The most a point may be grown to close coverage.
 *
 * A shape rather than a calibration. The cap matters more than its value: a
 * region sampled far too sparsely for the view cannot be made whole by drawing
 * bigger dots, and a renderer that kept growing them would turn a thin scan
 * into confident blobs. Past this the honest picture is the sparse one.
 */
export const MAX_COVERAGE_GROWTH = 4;

/**
 * Sample spacing on screen, in pixels.
 *
 * The same projection the streaming scheduler uses to decide whether a node
 * would add visible coverage, imported rather than restated: a renderer and a
 * scheduler that disagreed about how far apart the samples land would size for
 * one picture while loading for another.
 *
 * Null where it has no meaning, which the caller must treat as unknown rather
 * than as zero.
 */
export function renderSpacingPx(
  nodeSpacing: number,
  distance: number,
  focalLengthPx: number,
): number | null {
  return projectedSpacingPx(nodeSpacing, distance, focalLengthPx);
}

/**
 * How much to grow a point so it meets its neighbour, in `[1, MAX]`.
 *
 * Never below 1: this closes gaps and never shrinks a point, because shrinking
 * one would hide a sample that is genuinely there.
 *
 * An unknown spacing returns 1. A renderer that grew points on a spacing it
 * could not compute would be inventing coverage from nothing, and the failure
 * would look exactly like the feature working.
 */
export function coverageSizeFactor(
  spacingPx: number | null,
  drawnSizePx: number,
): number {
  if (spacingPx === null || !Number.isFinite(spacingPx) || spacingPx <= 0) return 1;
  if (!Number.isFinite(drawnSizePx) || drawnSizePx <= 0) return 1;
  if (spacingPx <= drawnSizePx) return 1;
  return Math.min(MAX_COVERAGE_GROWTH, spacingPx / drawnSizePx);
}

/** What one drawn set of samples looks like to this sizing. */
export interface CoverageSizingInput {
  /** Sample spacing in world units at the level being drawn. */
  readonly nodeSpacing: number;
  /** Distance from the camera to it, in world units. */
  readonly distance: number;
  /** Pinhole focal length in pixels, from the viewport and field of view. */
  readonly focalLengthPx: number;
  /** The size the point would be drawn at without this, in pixels. */
  readonly drawnSizePx: number;
}

/**
 * The whole path in one call, so a caller cannot project the spacing and then
 * forget the cap, or apply the cap to a spacing it never projected.
 */
export function coverageSizeMultiplier(input: CoverageSizingInput): number {
  return coverageSizeFactor(
    renderSpacingPx(input.nodeSpacing, input.distance, input.focalLengthPx),
    input.drawnSizePx,
  );
}

/**
 * Focal length in pixels for a perspective camera.
 *
 * The one piece of camera arithmetic this needs, kept here so a caller passes
 * a field of view and a height rather than deriving a focal length itself and
 * possibly deriving it differently.
 *
 * Null for anything that is not a usable perspective view, including an
 * orthographic one, where there is no focal length and a projected spacing is
 * a different calculation this does not do.
 */
export function focalLengthPxFor(verticalFovDeg: number, viewportHeightPx: number): number | null {
  if (!Number.isFinite(verticalFovDeg) || verticalFovDeg <= 0 || verticalFovDeg >= 180) return null;
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return null;
  const halfFovRad = (verticalFovDeg * Math.PI) / 360;
  const f = viewportHeightPx / (2 * Math.tan(halfFovRad));
  return Number.isFinite(f) && f > 0 ? f : null;
}
