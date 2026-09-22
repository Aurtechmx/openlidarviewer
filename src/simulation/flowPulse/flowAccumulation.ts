/**
 * flowAccumulation.ts — how much of the surface drains through each cell.
 *
 * Accumulation is pure topology over the D8 graph: a cell's value is the
 * number of cells upstream of it, itself included. Computed by draining cells
 * in dependency order rather than by walking downstream from each one, which
 * would be quadratic on a large grid and would revisit the same trunk cell
 * once per contributing cell.
 *
 * Counts and area are deliberately two functions. A count is always available,
 * because it asks nothing of the coordinate system. An area in square metres
 * asks whether the horizontal scale is known, and on a dataset with an
 * unresolved horizontal unit that question has no answer. Returning a number
 * anyway is the failure this split exists to prevent: an area is the figure a
 * reader quotes, and a wrong one is indistinguishable from a right one.
 *
 * Accumulation is not discharge. It counts cells, not water: no rainfall, no
 * infiltration and no time enter it.
 */

import { CELL_NODATA } from './flowTypes';
import type { D8Result } from './d8Flow';
import type { FlowGrid } from './flowTypes';

/**
 * Upstream cell count for every cell, itself included.
 *
 * A NoData cell gets 0: nothing drains through a cell that is not surface.
 * Cells caught in a receiver cycle keep their partial count rather than
 * hanging the loop, and the count of drained cells reports the shortfall.
 */
export interface AccumulationResult {
  /** Cells draining through each cell, including itself. NoData cells are 0. */
  readonly upstreamCells: Uint32Array;
  /** Valid cells that were resolved in dependency order. */
  readonly drainedCells: number;
  /** Valid cells left unresolved because they sit in a cycle. */
  readonly unresolvedCells: number;
}

/** Accumulate `d8` over `grid`. */
export function flowAccumulation(grid: FlowGrid, d8: D8Result): AccumulationResult {
  const { receiver, status } = d8;
  const n = grid.cols * grid.rows;
  const upstream = new Uint32Array(n);
  const donors = new Uint32Array(n);

  let valid = 0;
  for (let i = 0; i < n; i++) {
    if (status[i] === CELL_NODATA) continue;
    valid++;
    upstream[i] = 1; // every cell drains itself
    const r = receiver[i];
    if (r >= 0) donors[r]++;
  }

  // Cells nothing drains into are the heads of the network; draining one
  // frees its receiver to be drained in turn.
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (status[i] !== CELL_NODATA && donors[i] === 0) queue.push(i);
  }

  let drained = 0;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    drained++;
    const r = receiver[i];
    if (r < 0) continue;
    upstream[r] += upstream[i];
    if (--donors[r] === 0) queue.push(r);
  }

  return { upstreamCells: upstream, drainedCells: drained, unresolvedCells: valid - drained };
}

/**
 * Contributing area in square metres, or null when the scale is not known.
 *
 * `horizontalScaleResolved` is the caller's declaration that the grid's cell
 * metres mean metres. It is a parameter rather than something inferred from
 * the grid because the grid cannot tell: a cell size of 1 is equally a metre,
 * a degree, or an unknown source unit that defaulted to 1, and all three
 * produce the same plausible-looking number.
 */
export function contributingAreaM2(
  accumulation: AccumulationResult,
  grid: FlowGrid,
  horizontalScaleResolved: boolean,
): Float64Array | null {
  if (!horizontalScaleResolved) return null;
  const cellAreaM2 = grid.cellMetresX * grid.cellMetresY;
  const { upstreamCells } = accumulation;
  const area = new Float64Array(upstreamCells.length);
  for (let i = 0; i < upstreamCells.length; i++) area[i] = upstreamCells[i] * cellAreaM2;
  return area;
}

/**
 * Every cell draining through `outlet`, including it.
 *
 * Walks the graph backwards from the outlet. The visited set is what keeps a
 * receiver cycle from looping, the same hazard `traceDownstream` guards going
 * the other way.
 */
export function catchmentOf(grid: FlowGrid, d8: D8Result, outlet: number): Uint8Array {
  const n = grid.cols * grid.rows;
  const inCatchment = new Uint8Array(n);
  if (outlet < 0 || outlet >= n || d8.status[outlet] === CELL_NODATA) return inCatchment;

  // Donor lists, built once: walking every cell's receiver per step would be
  // quadratic, and a catchment query is something the UI runs on each click.
  const { receiver, status } = d8;
  const donorHead = new Int32Array(n).fill(-1);
  const donorNext = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (status[i] === CELL_NODATA) continue;
    const r = receiver[i];
    if (r < 0) continue;
    donorNext[i] = donorHead[r];
    donorHead[r] = i;
  }

  const stack = [outlet];
  inCatchment[outlet] = 1;
  while (stack.length > 0) {
    const cell = stack.pop() as number;
    for (let d = donorHead[cell]; d >= 0; d = donorNext[d]) {
      if (inCatchment[d] === 1) continue;
      inCatchment[d] = 1;
      stack.push(d);
    }
  }
  return inCatchment;
}
