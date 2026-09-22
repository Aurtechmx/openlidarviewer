/**
 * d8Flow.ts — single-flow-direction routing over an elevation grid.
 *
 * D8 (O'Callaghan & Mark 1984) sends every cell's flow to whichever of its
 * eight neighbours offers the steepest descent per unit of horizontal
 * distance. It is the coarsest defensible routing model: real water divides
 * across a divergent hillslope and D8 cannot, which is why the result is a
 * topographic routing graph and not a discharge field.
 *
 * Three decisions here are method rather than implementation, and each is
 * pinned by test:
 *
 * Distance is physical. The drop to a neighbour is divided by the metric
 * distance to it, so an anisotropic grid routes by real geometry. Dividing by
 * a raster-index distance instead would rank a diagonal against a cardinal
 * neighbour wrongly wherever the axes differ in metres.
 *
 * A pit and a flat are different answers. A cell whose neighbours are all
 * higher is a SINK. A cell with no lower neighbour but at least one at equal
 * elevation is a FLAT, and flats are reported rather than resolved: draining
 * them in array order would let iteration order masquerade as topography.
 * Conditioning is a separate, declared step.
 *
 * NoData is a wall. Flow neither enters nor leaves an invalid cell, and a
 * cell that would route off the grid edge is an OUTLET, which is a real
 * answer about where water leaves the mapped surface.
 */

import {
  CELL_FLAT,
  CELL_NODATA,
  CELL_OUTLET,
  CELL_ROUTED,
  CELL_SINK,
  D8_NEIGHBOURS,
  assertFlowGrid,
  type CellStatus,
  type FlowGrid,
} from './flowTypes';

/** A routed grid: where each cell sends its flow, and why. */
export interface D8Result {
  /** Index of the receiving cell, or -1 where flow does not leave. */
  readonly receiver: Int32Array;
  /** Which of {@link D8_NEIGHBOURS} was taken, or -1. */
  readonly direction: Int8Array;
  /** Per-cell {@link CellStatus}. */
  readonly status: Uint8Array;
  readonly sinkCount: number;
  readonly flatCount: number;
  readonly outletCount: number;
}

/**
 * Route `grid` with D8.
 *
 * The returned arrays are always cols×rows, so a caller can index them with
 * the same arithmetic it used to build the grid.
 */
export function d8Flow(grid: FlowGrid): D8Result {
  assertFlowGrid(grid);
  const { z, valid, cols, rows, cellMetresX, cellMetresY } = grid;
  const n = cols * rows;

  const receiver = new Int32Array(n).fill(-1);
  const direction = new Int8Array(n).fill(-1);
  const status = new Uint8Array(n);

  // Distance to each neighbour, in metres. Precomputed because it depends
  // only on the offset and the two axis scales, never on the cell.
  const stepMetres = D8_NEIGHBOURS.map(([dx, dy]) =>
    Math.hypot(dx * cellMetresX, dy * cellMetresY));

  let sinkCount = 0;
  let flatCount = 0;
  let outletCount = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const here = row * cols + col;
      if (valid[here] !== 1) {
        status[here] = CELL_NODATA;
        continue;
      }

      const zHere = z[here];
      let bestGradient = 0;
      let bestDir = -1;
      let bestCell = -1;
      let sawEqual = false;
      let sawEdge = false;

      for (let d = 0; d < D8_NEIGHBOURS.length; d++) {
        const [dx, dy] = D8_NEIGHBOURS[d];
        const nc = col + dx;
        const nr = row + dy;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) { sawEdge = true; continue; }
        const there = nr * cols + nc;
        if (valid[there] !== 1) continue;

        const drop = zHere - z[there];
        if (drop === 0) { sawEqual = true; continue; }
        if (drop < 0) continue;

        // Strictly greater, so the fixed neighbour order breaks exact ties.
        const gradient = drop / stepMetres[d];
        if (gradient > bestGradient) {
          bestGradient = gradient;
          bestDir = d;
          bestCell = there;
        }
      }

      if (bestDir >= 0) {
        receiver[here] = bestCell;
        direction[here] = bestDir;
        status[here] = CELL_ROUTED;
        continue;
      }

      // Nowhere lower to go. An edge cell with no lower neighbour still
      // drains off the mapped surface, which is an outlet rather than a pit:
      // calling it a sink would invent a depression at every grid boundary.
      if (sawEdge) { status[here] = CELL_OUTLET; outletCount++; continue; }
      if (sawEqual) { status[here] = CELL_FLAT; flatCount++; continue; }
      status[here] = CELL_SINK;
      sinkCount++;
    }
  }

  return { receiver, direction, status, sinkCount, flatCount, outletCount };
}

/**
 * Follow flow downstream from `start` until it leaves, pits or repeats.
 *
 * The visited guard is not defensive dressing. D8 on a conditioned surface
 * can produce a two-cell cycle where each of a pair routes to the other, and
 * a tracer without this check would spin forever inside a UI click handler.
 * Returns the path including `start`; the last cell's status says how it
 * ended.
 */
export function traceDownstream(result: D8Result, start: number): Int32Array {
  const { receiver, status } = result;
  if (start < 0 || start >= status.length || status[start] === CELL_NODATA) {
    return new Int32Array(0);
  }
  const path: number[] = [];
  const seen = new Set<number>();
  let at = start;
  while (at >= 0 && !seen.has(at)) {
    seen.add(at);
    path.push(at);
    at = receiver[at];
  }
  return Int32Array.from(path);
}

export { CELL_FLAT, CELL_NODATA, CELL_OUTLET, CELL_ROUTED, CELL_SINK };
export type { CellStatus, FlowGrid };
