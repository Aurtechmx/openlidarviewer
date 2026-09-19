/**
 * coverageBudget.ts
 *
 * Whether loading a node would put anything new on screen, as distinct from
 * putting more points in memory.
 *
 * The scheduler ranks candidates by depth and then by projected size. Projected
 * size answers how much of the screen a node occupies, which is not the same
 * question as how much of the screen it would improve. Two nodes can subtend
 * the same angle while one leaves visible holes between its samples and the
 * other is already finer than a pixel, and the second one costs a fetch, a
 * decode and a buffer to change nothing a viewer can see.
 *
 * The signal that separates them is spacing, which COPC nodes already carry:
 * the root spacing halved once per level. Projected through the camera it gives
 * the distance between neighbouring samples in pixels. Below one pixel the node
 * is oversampled for this view, and its points land on top of each other. Above
 * a few pixels it is leaving gaps that another level would close.
 *
 * Current temporal support is the other half. A region the accumulation has
 * already built up needs a new node less than an equally sparse region that has
 * nothing, so support discounts the need rather than replacing the measure of
 * it.
 *
 * What this must not do is change which nodes are candidates. Source
 * completeness is a property of the data, and everything that reads it, from the
 * evidence lens through to the export frontier, is entitled to the same answer
 * whatever the renderer thinks is worth looking at. So coverage REORDERS and
 * never excludes: the factor it produces is strictly positive, so no node is
 * ever scored down to the zero that means 'not a candidate this tick'. A node
 * that improves nothing visible goes last within its depth and still arrives.
 *
 * It also stays inside the size slot. The score is positional, with depth in the
 * upper digit and size in the lower, which is what makes the scheduler
 * coarse-first. Coverage multiplies the projected size exactly as the focus bias
 * already does, so it can reorder within a level and cannot reach across one.
 *
 * Pure: no GPU, no DOM, no fetch. Rendering priority only, and nothing here
 * reaches measurement, completeness or claim evidence.
 */

/**
 * Sample spacing in pixels, for a node at this distance.
 *
 * `focalLengthPx` is the pinhole focal length in pixels, which the caller has
 * from its own viewport and field of view. A non-positive distance means the
 * camera is inside or behind the node, where a projected spacing has no
 * meaning, so it reports null rather than a number built from a division by
 * something near zero.
 */
export function projectedSpacingPx(
  spacing: number,
  distance: number,
  focalLengthPx: number,
): number | null {
  if (!Number.isFinite(spacing) || spacing <= 0) return null;
  if (!Number.isFinite(distance) || distance <= 0) return null;
  if (!Number.isFinite(focalLengthPx) || focalLengthPx <= 0) return null;
  const px = (spacing * focalLengthPx) / distance;
  return Number.isFinite(px) ? px : null;
}

/**
 * Spacing at or below which a node adds no visible coverage.
 *
 * One pixel, which is a property of the display rather than a tuning choice:
 * samples closer together than a pixel cannot be told apart on screen.
 */
export const OVERSAMPLED_SPACING_PX = 1;

/**
 * Spacing at which a node's coverage need is counted as full.
 *
 * A starting value, not a measured one. Samples four pixels apart leave gaps
 * wide enough that a viewer reads them as holes rather than as texture. The
 * figure that belongs here comes from real scenes at several densities, and
 * until then it is a shape rather than a calibration.
 */
export const FULL_NEED_SPACING_PX = 4;

/**
 * How much a node would improve visible coverage, in `[0, 1]`.
 *
 * Zero at or below a pixel of spacing, rising to one at
 * {@link FULL_NEED_SPACING_PX}. An unknown spacing returns full need rather
 * than none: a node whose spacing cannot be projected has not been shown to be
 * redundant, and treating unknown as redundant would quietly deprioritise every
 * node of a source that does not report spacing.
 */
export function coverageNeed(spacingPx: number | null): number {
  if (spacingPx === null || !Number.isFinite(spacingPx)) return 1;
  if (spacingPx <= OVERSAMPLED_SPACING_PX) return 0;
  if (spacingPx >= FULL_NEED_SPACING_PX) return 1;
  return (
    (spacingPx - OVERSAMPLED_SPACING_PX) /
    (FULL_NEED_SPACING_PX - OVERSAMPLED_SPACING_PX)
  );
}

/**
 * Need after discounting what the accumulation has already built.
 *
 * `support` is the share of the region already carried by history, in `[0, 1]`,
 * taken as a fact from whoever censused it. A non-finite or out-of-range value
 * discounts nothing, because a support figure that is not a share is not
 * evidence that anything is covered.
 */
export function discountedNeed(need: number, support: number): number {
  const n = Number.isFinite(need) ? Math.min(1, Math.max(0, need)) : 1;
  if (!Number.isFinite(support) || support < 0 || support > 1) return n;
  return n * (1 - support);
}

/**
 * The smallest factor a node can be scaled by.
 *
 * Strictly positive, and that is the guarantee rather than a tuning choice. A
 * factor of zero would score a node the same as one past the depth cap, which
 * the scheduler reads as 'not a candidate', and a node that is never a
 * candidate never arrives. Source completeness would then depend on what the
 * camera was looking at.
 */
export const MIN_COVERAGE_FACTOR = 0.1;

/**
 * The multiplier for a node's projected size, in `(0, 1]`.
 *
 * Shaped like the focus bias so the two compose inside the same slot: both
 * shrink a projected size and neither can grow one, so the size term stays
 * within its band and depth keeps dominating.
 */
export function coverageFactor(need: number, support: number): number {
  const n = discountedNeed(need, support);
  const f = MIN_COVERAGE_FACTOR + (1 - MIN_COVERAGE_FACTOR) * n;
  if (!Number.isFinite(f)) return MIN_COVERAGE_FACTOR;
  return Math.min(1, Math.max(MIN_COVERAGE_FACTOR, f));
}

/** The small per-node descriptor the scheduler would carry. */
export interface NodeCoverageDescriptor {
  /** Sample spacing at this node's depth, in world units. */
  readonly spacing: number;
  /** Distance from the camera to the node, in world units. */
  readonly distance: number;
  /** Share of this node's region already carried by history, in `[0, 1]`. */
  readonly temporalSupport: number;
}

/**
 * The factor for one node, from the descriptor the phase describes.
 *
 * The whole path in one call so a caller cannot assemble the pieces in an order
 * that skips the discount or the floor.
 */
export function nodeCoverageFactor(
  descriptor: NodeCoverageDescriptor,
  focalLengthPx: number,
): number {
  const px = projectedSpacingPx(descriptor.spacing, descriptor.distance, focalLengthPx);
  return coverageFactor(coverageNeed(px), descriptor.temporalSupport);
}
