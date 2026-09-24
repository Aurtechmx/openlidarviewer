/**
 * flowGridCursor.ts — pure cell/cursor math for the Flow Pulse result grid.
 *
 * `Viewer.ts` exposes no picking seam a lazy feature can reach without adding
 * lines to the monolith — `derivedLayerHost()` is scene membership only, and a
 * real click-to-pick would need the live camera and canvas, neither of which
 * is public. So click-to-pulse and the catchment outlet are chosen on a 2D
 * raster of the routed DTM instead: a rendering of the result grid the Lab
 * draws in its own panel, clickable with a pointer and walkable with arrow
 * keys. Every mapping a pointer or a key press needs — canvas pixel to cell,
 * cursor step, a cell's readable status — lives here, three-free and DOM-free,
 * so the address a click resolves to is unit-tested without a browser.
 *
 * Pure: no DOM, no three.js.
 */

import { CELL_FLAT, CELL_NODATA, CELL_OUTLET, CELL_ROUTED, CELL_SINK } from './flowTypes';
import type { AccumulationResult } from './flowAccumulation';
import type { D8Result } from './d8Flow';
import type { FlowGrid } from './flowTypes';

/** A cell address in a routed grid. */
export interface GridCell {
  readonly col: number;
  readonly row: number;
}

/** Clamp (col, row) into a `cols × rows` grid, rounding to the nearest cell. */
export function clampCell(cols: number, rows: number, col: number, row: number): GridCell {
  const maxCol = Math.max(cols - 1, 0);
  const maxRow = Math.max(rows - 1, 0);
  const c = Math.min(Math.max(Math.round(col), 0), maxCol);
  const r = Math.min(Math.max(Math.round(row), 0), maxRow);
  return { col: c, row: r };
}

/** Move a cursor by a keyboard delta, clamped to stay on the grid. */
export function moveCursor(
  cols: number,
  rows: number,
  from: GridCell,
  dCol: number,
  dRow: number,
): GridCell {
  return clampCell(cols, rows, from.col + dCol, from.row + dRow);
}

/** True when (col, row) is a real address in a `cols × rows` grid. */
export function inBounds(cols: number, rows: number, col: number, row: number): boolean {
  return Number.isInteger(col) && Number.isInteger(row)
    && col >= 0 && col < cols && row >= 0 && row < rows;
}

/** Row-major cell index, matching every routing array's own indexing. */
export function cellIndex(cols: number, cell: GridCell): number {
  return cell.row * cols + cell.col;
}

/** The inverse of {@link cellIndex}. */
export function cellAt(cols: number, index: number): GridCell {
  return { col: index % cols, row: Math.floor(index / cols) };
}

/**
 * Map a pointer position over a `canvasW × canvasH` rendering of a
 * `cols × rows` grid back to the cell under it. Nearest-cell: a point exactly
 * on a shared edge resolves to one side rather than reading as a miss.
 * Returns null only when the point is off the canvas or the grid is empty.
 */
export function pixelToCell(
  cols: number,
  rows: number,
  canvasW: number,
  canvasH: number,
  px: number,
  py: number,
): GridCell | null {
  if (cols <= 0 || rows <= 0 || canvasW <= 0 || canvasH <= 0) return null;
  if (px < 0 || py < 0 || px >= canvasW || py >= canvasH) return null;
  const col = Math.floor((px / canvasW) * cols);
  const row = Math.floor((py / canvasH) * rows);
  return clampCell(cols, rows, col, row);
}

/** The status word a reader sees for a routed cell. */
export function statusLabel(status: number): string {
  switch (status) {
    case CELL_ROUTED: return 'routed';
    case CELL_SINK: return 'sink';
    case CELL_FLAT: return 'flat, unresolved';
    case CELL_OUTLET: return 'outlet';
    case CELL_NODATA: return 'no data';
    default: return 'unknown';
  }
}

/** A readable summary of one cell, for the live region and the status row. */
export interface CellReport {
  readonly col: number;
  readonly row: number;
  readonly readable: boolean;
  readonly elevation: number | null;
  readonly status: string;
  readonly upstreamCells: number | null;
  readonly contributingAreaM2: number | null;
}

/** Describe the cell at `cell` from an already-routed grid. */
export function describeCell(
  grid: FlowGrid,
  routed: D8Result,
  accumulation: AccumulationResult,
  areaM2: Float64Array | null,
  cell: GridCell,
): CellReport {
  const i = cellIndex(grid.cols, cell);
  const readable = grid.valid[i] === 1;
  return {
    col: cell.col,
    row: cell.row,
    readable,
    elevation: readable ? grid.z[i] : null,
    status: statusLabel(routed.status[i]),
    upstreamCells: readable ? accumulation.upstreamCells[i] : null,
    contributingAreaM2: readable && areaM2 ? areaM2[i] : null,
  };
}

/** One sentence for the live region announcing a cursor move or activation. */
export function cellAnnouncement(report: CellReport): string {
  if (!report.readable) return `Column ${report.col}, row ${report.row}, no elevation.`;
  const area = report.contributingAreaM2 != null
    ? `, ${report.contributingAreaM2.toFixed(1)} square metres contributing`
    : '';
  return `Column ${report.col}, row ${report.row}, elevation ${report.elevation!.toFixed(2)}, `
    + `${report.status}, ${report.upstreamCells} cell(s) upstream${area}.`;
}
