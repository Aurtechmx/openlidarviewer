/**
 * pourPointSnap.ts — move a clicked catchment outlet onto the channel beside it.
 *
 * A D8 channel is one cell wide. A pointer click that lands one cell off a
 * trunk channel picks a hillslope cell whose catchment is a handful of cells,
 * where the reader meant the trunk's thousands. Standard practice (the
 * WhiteboxTools SnapPourPoints and ArcGIS Snap Pour Point tools) moves the
 * outlet to the cell of highest flow accumulation within a small search
 * distance. This does the same within a square window of `radius` cells
 * (Chebyshev distance), over cells that carry an elevation.
 *
 * Ties keep the clicked cell when it is among them, then the nearest
 * (Euclidean, in cells), then the lowest index, so the choice never depends on
 * scan order. A keyboard selection is exact and never calls this.
 *
 * Pure: no DOM.
 */

import { CELL_NODATA } from './flowTypes';
import type { GridCell } from './flowGridCursor';

/** Search radius the Lab snaps within, in cells. */
export const POUR_POINT_SNAP_RADIUS_CELLS = 2;

export interface SnapResult {
  /** The cell the outlet moved to (the clicked cell when nothing beats it). */
  readonly cell: GridCell;
  /** The cell that was clicked. */
  readonly from: GridCell;
  /** True when `cell` differs from `from`. */
  readonly snapped: boolean;
}

/**
 * The highest-accumulation cell within `radius` cells of `from`. A click
 * outside the grid, or with no valid cell in reach, returns `from` unchanged
 * so the caller's own refusal still reports it.
 */
export function snapPourPoint(
  cols: number,
  rows: number,
  status: ArrayLike<number>,
  upstreamCells: ArrayLike<number>,
  from: GridCell,
  radius = POUR_POINT_SNAP_RADIUS_CELLS,
): SnapResult {
  const unchanged: SnapResult = { cell: from, from, snapped: false };
  if (from.col < 0 || from.row < 0 || from.col >= cols || from.row >= rows) return unchanged;
  let best = -1, bestUp = -1, bestDist = Number.POSITIVE_INFINITY;
  const here = from.row * cols + from.col;
  for (let r = Math.max(0, from.row - radius); r <= Math.min(rows - 1, from.row + radius); r++) {
    for (let c = Math.max(0, from.col - radius); c <= Math.min(cols - 1, from.col + radius); c++) {
      const i = r * cols + c;
      if (status[i] === CELL_NODATA) continue;
      const up = upstreamCells[i]!;
      const dist = Math.hypot(c - from.col, r - from.row);
      const better = up > bestUp
        || (up === bestUp && best !== here && (i === here || dist < bestDist || (dist === bestDist && i < best)));
      if (better) { best = i; bestUp = up; bestDist = dist; }
    }
  }
  if (best < 0 || best === here) return unchanged;
  const cell = { col: best % cols, row: Math.floor(best / cols) };
  return { cell, from, snapped: true };
}
