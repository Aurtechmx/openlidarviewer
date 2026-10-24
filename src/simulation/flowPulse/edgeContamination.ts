/**
 * edgeContamination.ts — which cells may drain ground the survey never saw.
 *
 * A contributing area is only complete when every cell upslope of the outlet
 * is on the grid. A cell on the edge of the mapped surface (the grid border,
 * or beside NoData that reaches the border, which lies outside the survey)
 * that routes INTO the surface could also receive water from the unsurveyed
 * ground beyond it, so every cell downstream of it may drain more area than
 * the grid can count. Such a cell is edge-contaminated (Lindsay's D8
 * criterion, as in the WhiteboxTools EdgeContamination tool): its contributing
 * area is a lower bound, and so is any figure built from it.
 *
 * An edge cell that is itself terminal (an outlet, sink or flat: no receiver)
 * is not a seed: flow leaves the surface there rather than entering it. NoData
 * the survey encloses (a hole) is a routing wall, not outside ground, so a
 * cell beside a hole is not an edge cell; that matches `outsideSurface`,
 * which D8 and Priority-Flood already use.
 *
 * Seeds are pushed downstream along the D8 receivers in dependency order (a
 * cell is finished once every donor has been), so the pass is O(n) and a
 * catchment is contaminated exactly when its outlet cell is.
 *
 * Pure: no DOM. Reads the routed grid; changes nothing.
 */

import { CELL_NODATA, outsideSurface, type FlowGrid } from './flowTypes';
import type { D8Result } from './d8Flow';

/**
 * 1 for each valid cell on the edge of the mapped surface: the grid border, or
 * 8-adjacent to NoData that reaches the border.
 */
export function surveyEdgeCells(grid: FlowGrid): Uint8Array {
  const { cols, rows, valid } = grid;
  const outside = outsideSurface(grid);
  const edge = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (valid[i] !== 1) continue;
      if (c === 0 || r === 0 || c === cols - 1 || r === rows - 1) { edge[i] = 1; continue; }
      search: for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if ((dr !== 0 || dc !== 0) && outside[(r + dr) * cols + c + dc] === 1) { edge[i] = 1; break search; }
        }
      }
    }
  }
  return edge;
}

/** The per-cell flag and the counts a caller reports. */
export interface EdgeContamination {
  /** 1 where the cell's upslope area may extend past the mapped surface. */
  readonly contaminated: Uint8Array;
  /** Edge cells that route into the surface: the seeds. */
  readonly inwardEdgeCells: number;
  /** Valid cells flagged. */
  readonly contaminatedCells: number;
}

/** Flag every cell whose D8 upslope area holds an edge cell that routes inward. */
export function edgeContamination(grid: FlowGrid, routed: D8Result): EdgeContamination {
  const n = grid.cols * grid.rows;
  const { receiver, status } = routed;
  const edge = surveyEdgeCells(grid);
  const flag = new Uint8Array(n);
  const donors = new Uint32Array(n);
  let seeds = 0;
  for (let i = 0; i < n; i++) {
    if (status[i] === CELL_NODATA) continue;
    const r = receiver[i]!;
    if (r >= 0) donors[r]++;
    if (edge[i] === 1 && r >= 0) { flag[i] = 1; seeds++; }
  }
  // Drain in dependency order, carrying the flag to each receiver.
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (status[i] !== CELL_NODATA && donors[i] === 0) queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const r = receiver[i]!;
    if (r < 0) continue;
    if (flag[i] === 1) flag[r] = 1;
    if (--donors[r] === 0) queue.push(r);
  }
  let count = 0;
  for (let i = 0; i < n; i++) if (flag[i] === 1) count++;
  return { contaminated: flag, inwardEdgeCells: seeds, contaminatedCells: count };
}

/** The sentence beside an area that is a lower bound. */
export const EDGE_CONTAMINATED_NOTE =
  'at least: the catchment reaches the survey edge, so ground outside the survey may also drain here';
