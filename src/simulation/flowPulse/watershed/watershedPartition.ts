/**
 * watershedPartition.ts — which watershed each routed cell belongs to.
 *
 * Every cell with no receiver (an outlet, a sink or a flat) is a terminal:
 * the place where flow stops or leaves the surface. The cells that drain to
 * one terminal form its watershed. They are found in one pass, walking the
 * donor lists backwards from each terminal as `catchmentOf` does, so the cost
 * is O(n) however many watersheds there are, and a watershed's size is the
 * accumulation count at its terminal. NoData, and any cell caught in a
 * receiver cycle (which no terminal reaches), keep label 0.
 *
 * Each watershed carries two honesty flags. `complete` is false when any of
 * its cells is edge-contaminated, so its area is a lower bound.
 * `edgeInflowShare` says how much of its boundary is survey edge that routes
 * water inward, which is where unsurveyed ground may add to it. `minor` marks
 * a watershed under a small share of the analysed surface, so a caller can
 * group the slivers a grid edge produces instead of listing each one.
 *
 * Pure: no DOM. Reads the routed grid; changes nothing.
 */

import { surveyEdgeCells, type EdgeContamination } from '../edgeContamination';
import { CELL_NODATA, D8_NEIGHBOURS, type FlowGrid } from '../flowTypes';
import type { D8Result } from '../d8Flow';
import type { AccumulationResult } from '../flowAccumulation';

/** Smallest share of the readable cells a watershed needs to be listed on its own. */
export const DEFAULT_MINOR_SHARE = 0.01;

export interface WatershedInfo {
  /** 1-based, largest first; ties by lowest terminal index. */
  readonly id: number;
  /** Cell index where flow stops or leaves. */
  readonly terminal: number;
  readonly cells: number;
  /** No contaminated cell in the watershed. */
  readonly complete: boolean;
  /** Inward-routing survey-edge cells on its boundary over its boundary cells, 0..1. */
  readonly edgeInflowShare: number;
  /** Fewer cells than the minimum share of the readable cells. */
  readonly minor: boolean;
}

export interface WatershedPartition {
  /** Per cell: watershed id, 0 for NoData and unresolved cells. */
  readonly label: Int32Array;
  readonly watersheds: readonly WatershedInfo[];
}

export function partitionWatersheds(
  grid: FlowGrid,
  routed: D8Result,
  acc: AccumulationResult,
  edge: EdgeContamination,
  minShare: number = DEFAULT_MINOR_SHARE,
): WatershedPartition {
  const { cols, rows } = grid;
  const n = cols * rows;
  const { receiver, status } = routed;

  // Donor lists: for each cell, a linked list of the cells that send to it.
  const donorHead = new Int32Array(n).fill(-1);
  const donorNext = new Int32Array(n).fill(-1);
  const terminals: number[] = [];
  for (let i = 0; i < n; i++) {
    if (status[i] === CELL_NODATA) continue;
    const r = receiver[i]!;
    if (r < 0) { terminals.push(i); continue; }
    donorNext[i] = donorHead[r]!;
    donorHead[r] = i;
  }

  // Provisional label = position in `terminals` + 1; each cell is visited once.
  const provisional = new Int32Array(n);
  const stack: number[] = [];
  for (let t = 0; t < terminals.length; t++) {
    const terminal = terminals[t]!;
    provisional[terminal] = t + 1;
    stack.push(terminal);
    while (stack.length > 0) {
      const cell = stack.pop()!;
      for (let d = donorHead[cell]!; d >= 0; d = donorNext[d]!) {
        provisional[d] = t + 1;
        stack.push(d);
      }
    }
  }

  // Rank: largest first, ties by the lowest terminal index (already ascending).
  const order = terminals.map((terminal, t) => ({ t, terminal, cells: acc.upstreamCells[terminal]! }));
  order.sort((a, b) => b.cells - a.cells || a.terminal - b.terminal);
  const idOf = new Int32Array(terminals.length + 1);
  order.forEach((o, rank) => { idOf[o.t + 1] = rank + 1; });

  const label = new Int32Array(n);
  let readable = 0;
  const open = new Uint8Array(terminals.length + 1);
  for (let i = 0; i < n; i++) {
    const p = provisional[i]!;
    if (p === 0) continue;
    label[i] = idOf[p]!;
    readable++;
    if (edge.contaminated[i] === 1) open[p] = 1;
  }

  // Boundary cells (a neighbour off the grid, outside the watershed or NoData)
  // and the survey-edge cells among them that route inward.
  const surveyEdge = surveyEdgeCells(grid);
  const boundary = new Uint32Array(terminals.length + 1);
  const inward = new Uint32Array(terminals.length + 1);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const p = provisional[i]!;
      if (p === 0) continue;
      let onBoundary = false;
      for (const [dc, dr] of D8_NEIGHBOURS) {
        const nc = col + dc, nr = row + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows || provisional[nr * cols + nc] !== p) {
          onBoundary = true;
          break;
        }
      }
      if (!onBoundary) continue;
      boundary[p]++;
      if (surveyEdge[i] === 1 && receiver[i]! >= 0) inward[p]++;
    }
  }

  const watersheds: WatershedInfo[] = order.map((o, rank) => {
    const p = o.t + 1;
    return {
      id: rank + 1,
      terminal: o.terminal,
      cells: o.cells,
      complete: open[p] === 0,
      edgeInflowShare: boundary[p]! > 0 ? inward[p]! / boundary[p]! : 0,
      minor: o.cells < minShare * readable,
    };
  });

  return { label, watersheds };
}
