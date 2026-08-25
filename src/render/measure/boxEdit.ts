/**
 * boxEdit.ts
 *
 * Pure corner-resize mathematics for a Box measurement. No three.js, no DOM,
 * so the "where does this box end up" question is answerable in Node without
 * a viewer.
 *
 * A box is stored as two opposite pick points and normalised by
 * `boxFromCorners`, so it is axis-aligned by construction. Resizing it from a
 * corner therefore has exactly one honest meaning: the corner diagonally
 * opposite the grabbed one stays where it is, and the grabbed corner moves to
 * the new point. Everything else (which extents grow, which shrink, whether
 * the drag crossed the anchor) falls out of re-normalising that pair.
 */

import { boxFromCorners, boxCorners, type BoxBounds } from './geometry';
import type { Vec3 } from '../navMath';

/** An index into the 8 corners `boxCorners` emits, in that same order. */
export type BoxCornerIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Every corner index, for callers that draw a handle on each one. */
export const BOX_CORNER_INDICES: readonly BoxCornerIndex[] = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * The corner diagonally across the box from `corner`, in `boxCorners` order.
 *
 * `boxCorners` emits the low face first (indices 0-3, CCW) then the high face
 * (4-7, CCW from the same start), both relative to the scan's up-axis. Across
 * the body diagonal that pairs 0 with 6, 1 with 7, 2 with 4 and 3 with 5. The
 * mapping is its own inverse, which is what lets a drag that crosses the
 * anchor be handled by re-normalisation instead of by re-indexing.
 */
export function oppositeCornerIndex(corner: BoxCornerIndex): BoxCornerIndex {
  const OPPOSITE: readonly BoxCornerIndex[] = [6, 7, 4, 5, 2, 3, 0, 1];
  return OPPOSITE[corner];
}

/**
 * The box that results from dragging one corner to `dragged`, with the
 * opposite corner held fixed.
 *
 * `up` selects which axis `corner` counts as vertical, exactly as it does in
 * `boxCorners`; a Y-up frame (phone-scan meshes) numbers its corners around a
 * different pair of horizontal axes, so passing the wrong up vector anchors
 * the drag to the wrong corner rather than merely mislabelling one.
 *
 * A drag past the anchor is not an error state: `boxFromCorners` re-normalises
 * per axis, so the result always has `min <= max` on every axis and the box
 * flips through zero extent rather than inverting.
 */
export function resizeBoxByCorner(
  box: BoxBounds,
  corner: BoxCornerIndex,
  dragged: Vec3,
  up: Vec3 = [0, 0, 1],
): BoxBounds {
  const anchor = boxCorners(box, up)[oppositeCornerIndex(corner)];
  return boxFromCorners(anchor, dragged);
}
