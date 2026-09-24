/**
 * flowClickGuard.ts — the honesty gate in front of pulseFrom/catchmentFrom.
 *
 * §18 (async transaction safety): a displayed path or catchment must never
 * outlive the field it was traced over. `runFlowPulse` runs synchronously, so
 * nothing here waits on I/O — the hazard is a slower one. The Field Simulation
 * Lab stays open (a modal) while the app underneath it moves on: a re-run, a
 * classification edit, a closed scan. A click that lands after that would
 * trace a path over a field that is no longer what is drawn. The caller
 * declares that possibility through `isStale`, evaluated at the moment of the
 * click rather than once at open, and this module refuses honestly instead of
 * tracing over a field it can no longer vouch for.
 *
 * The other two refusals are about the click itself, not the field: a cell
 * with no elevation has no receiver to trace, and a cell address outside the
 * grid is not a cell at all. Both are answers routing already gave, not
 * exceptions to catch.
 *
 * Pure: no DOM, no three.js.
 */

import { cellIndex, inBounds, type GridCell } from './flowGridCursor';
import { catchmentFrom, pulseFrom, type FlowPulseResult } from './flowPulseRunner';
import type { FlowCellStatus } from './flowTypes';

export type FlowClickRefusalCode = 'OUTSIDE_GRID' | 'NO_VALID_CELL' | 'STALE_INPUT';

/** A click or an outlet choice that did not run, and why. */
export interface FlowClickRefusal {
  readonly ok: false;
  readonly code: FlowClickRefusalCode;
  readonly reason: string;
}

/** A traced downstream path. */
export interface FlowPathTrace {
  readonly ok: true;
  readonly cell: GridCell;
  readonly path: Int32Array;
  /** {@link FlowCellStatus} of the last cell the path reached. */
  readonly endStatus: FlowCellStatus;
}

/** A traced upstream catchment. */
export interface FlowCatchmentTrace {
  readonly ok: true;
  readonly cell: GridCell;
  readonly mask: Uint8Array;
  readonly cells: number;
}

/** Shared precondition every click and every outlet choice must clear. */
function guard(
  result: FlowPulseResult,
  cell: GridCell,
  isStale: boolean,
): FlowClickRefusal | null {
  if (isStale) {
    return {
      ok: false,
      code: 'STALE_INPUT',
      reason: 'The terrain behind this run has changed since it ran. Re-run Flow Pulse '
        + 'before tracing a path or a catchment.',
    };
  }
  if (!inBounds(result.grid.cols, result.grid.rows, cell.col, cell.row)) {
    return {
      ok: false,
      code: 'OUTSIDE_GRID',
      reason: `Cell (${cell.col}, ${cell.row}) is outside the ${result.grid.cols}×${result.grid.rows} grid.`,
    };
  }
  const i = cellIndex(result.grid.cols, cell);
  if (result.grid.valid[i] !== 1) {
    return {
      ok: false,
      code: 'NO_VALID_CELL',
      reason: `Cell (${cell.col}, ${cell.row}) carries no elevation, so it has no downstream `
        + 'neighbour to trace.',
    };
  }
  return null;
}

/** Trace the downstream path from `cell`, or refuse honestly. */
export function traceClick(
  result: FlowPulseResult,
  cell: GridCell,
  isStale: boolean,
): FlowPathTrace | FlowClickRefusal {
  const refusal = guard(result, cell, isStale);
  if (refusal) return refusal;
  const i = cellIndex(result.grid.cols, cell);
  const path = pulseFrom(result, i);
  const last = path.length > 0 ? path[path.length - 1] : i;
  return { ok: true, cell, path, endStatus: result.routed.status[last] as FlowCellStatus };
}

/** Trace every cell draining to `cell`, or refuse honestly. */
export function catchmentClick(
  result: FlowPulseResult,
  cell: GridCell,
  isStale: boolean,
): FlowCatchmentTrace | FlowClickRefusal {
  const refusal = guard(result, cell, isStale);
  if (refusal) return refusal;
  const i = cellIndex(result.grid.cols, cell);
  const mask = catchmentFrom(result, i);
  let cells = 0;
  for (let k = 0; k < mask.length; k++) if (mask[k] === 1) cells++;
  return { ok: true, cell, mask, cells };
}
