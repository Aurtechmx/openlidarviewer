/**
 * flowLength.ts — downstream flow length to one outlet along the D8 graph.
 *
 * For every cell that drains to `outlet`, the distance water would travel
 * along its D8 path to get there: the sum of its steps, each step the physical
 * distance between the two cell centres. On a projected grid with square cells
 * an orthogonal step is one cell size and a diagonal step √2 cell sizes; in
 * general a step of (dx, dy) cells is hypot(dx·cellMetresX, dy·cellMetresY),
 * the same distance D8 ranks its neighbours by, so an anisotropic grid stays
 * correct.
 *
 * One pass from the outlet upstream over the reverse D8 tree: a cell's length
 * is its receiver's length plus its own step, so each cell is visited once.
 * D8 gives every cell at most one receiver, so the catchment is a tree; the
 * visited guard only defends against a malformed receiver array.
 *
 * It is a distance, not a time. No velocity enters it, and nothing here says
 * how long water takes to arrive.
 *
 * Pure: no DOM.
 */

import { CELL_NODATA, D8_NEIGHBOURS, type FlowGrid } from './flowTypes';
import type { D8Result } from './d8Flow';

/** Unit a flow length is stated in: metres, or cell lengths when the scale is unresolved. */
export type FlowLengthUnit = 'm' | 'cells';

export interface FlowLengthResult {
  /** Length per cell to the outlet; NaN for cells that do not drain to it. */
  readonly length: Float64Array;
  /** Longest flow length in the catchment (0 for a one-cell catchment). */
  readonly maxLength: number;
  /** Cells that drain to the outlet, the outlet included. */
  readonly cells: number;
  readonly unit: FlowLengthUnit;
}

/**
 * Flow length to `outlet` for every cell draining to it. In `'cells'` the
 * east-west cell length is the unit (the north-south step is scaled by the
 * grid's own axis ratio), for a grid whose metres are not resolved.
 */
export function flowLengthToOutlet(
  grid: FlowGrid,
  routed: D8Result,
  outlet: number,
  unit: FlowLengthUnit = 'm',
): FlowLengthResult {
  const n = grid.cols * grid.rows;
  const length = new Float64Array(n).fill(Number.NaN);
  if (outlet < 0 || outlet >= n || routed.status[outlet] === CELL_NODATA) {
    return { length, maxLength: 0, cells: 0, unit };
  }
  const mx = unit === 'm' ? grid.cellMetresX : 1;
  const my = unit === 'm' ? grid.cellMetresY : grid.cellMetresY / grid.cellMetresX;
  const step = D8_NEIGHBOURS.map(([dx, dy]) => Math.hypot(dx * mx, dy * my));

  // Donor lists, built once.
  const { receiver, status } = routed;
  const head = new Int32Array(n).fill(-1);
  const next = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (status[i] === CELL_NODATA) continue;
    const r = receiver[i]!;
    if (r < 0) continue;
    next[i] = head[r]!;
    head[r] = i;
  }

  length[outlet] = 0;
  let maxLength = 0;
  let cells = 1;
  const stack = [outlet];
  while (stack.length > 0) {
    const c = stack.pop()!;
    for (let d = head[c]!; d >= 0; d = next[d]!) {
      if (!Number.isNaN(length[d]!)) continue;
      const dir = routed.direction[d]!;
      const len = length[c]! + (dir >= 0 ? step[dir]! : stepBetween(grid, d, c, mx, my));
      length[d] = len;
      if (len > maxLength) maxLength = len;
      cells++;
      stack.push(d);
    }
  }
  return { length, maxLength, cells, unit };
}

/** Distance between two cell centres, for a receiver with no recorded direction. */
function stepBetween(grid: FlowGrid, a: number, b: number, mx: number, my: number): number {
  const ac = a % grid.cols, bc = b % grid.cols;
  return Math.hypot((bc - ac) * mx, ((b - bc) / grid.cols - (a - ac) / grid.cols) * my);
}
