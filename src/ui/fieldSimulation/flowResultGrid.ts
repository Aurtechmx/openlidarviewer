/**
 * flowResultGrid.ts — the keyboard- and pointer-accessible stand-in for
 * clicking the scan.
 *
 * `Viewer.ts` has no picking seam a lazy feature can reach without growing the
 * monolith (`derivedLayerHost()` is scene membership only; a real click on the
 * live point cloud would need the camera and canvas, neither of which is
 * public), so the Lab draws its own small raster of the routed grid and reads
 * clicks and arrow keys against THAT instead — the alternative the spec itself
 * names ("a keyboard-accessible cell cursor on the result grid"). A mouse
 * click and an Enter/Space activation are the same event to a listener: both
 * name a cell and ask the Lab to act on it, per whichever mode (trace / set
 * outlet) is current.
 *
 * The canvas is a picture for a sighted pointer user; a screen-reader user
 * never has to read it; the plain-text status line below it (kept in sync on
 * every cursor move) is what actually carries the cell's identity and, in the
 * live region the Lab owns, its description. Pixel colour is not load-bearing
 * for any behaviour this module tests — cursor state and the status line are.
 */

import {
  cellAnnouncement,
  cellIndex,
  clampCell,
  describeCell,
  moveCursor,
  pixelToCell,
  type CellReport,
  type ElevationReference,
  type GridCell,
} from '../../simulation/flowPulse/flowGridCursor';
import { CELL_NODATA, CELL_OUTLET, CELL_SINK } from '../../simulation/flowPulse/flowTypes';
import type { AccumulationResult } from '../../simulation/flowPulse/flowAccumulation';
import type { D8Result } from '../../simulation/flowPulse/d8Flow';
import type { FlowGrid } from '../../simulation/flowPulse/flowTypes';

const CANVAS_MAX = 320;

export interface FlowResultGridOptions {
  readonly ariaLabel: string;
  /** A cell was activated — a click, or Enter/Space on the keyboard cursor. */
  readonly onActivate: (cell: GridCell) => void;
  /** The keyboard/pointer cursor moved to a new cell (no activation). */
  readonly onMove: (cell: GridCell, report: CellReport) => void;
  /**
   * How to recover a real-world elevation from the grid's local z. Optional
   * and defaults to null — a caller with no resolved origin or vertical
   * unit still gets reports, honestly labelled 'unknown'.
   */
  readonly elevationRef?: ElevationReference | null;
}

/** Flat status colours — legible at a glance, no gradient to misread as data. */
const STATUS_COLOR: Record<number, string> = {
  [CELL_NODATA]: '#1c1f26',
  [CELL_SINK]: '#c25b5b',
  [CELL_OUTLET]: '#5b9dc2',
};
const ROUTED_COLOR = '#3a4a3a';
const FLAT_COLOR = '#8a7d3a';

export class FlowResultGrid {
  readonly element: HTMLElement;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _status: HTMLElement;
  private readonly _onActivate: FlowResultGridOptions['onActivate'];
  private readonly _onMove: FlowResultGridOptions['onMove'];
  private readonly _elevationRef: ElevationReference | null;

  private _grid: FlowGrid | null = null;
  private _routed: D8Result | null = null;
  private _accumulation: AccumulationResult | null = null;
  private _areaM2: Float64Array | null = null;
  private _cursor: GridCell = { col: 0, row: 0 };
  private _pathMask: Uint8Array | null = null;
  private _catchmentMask: Uint8Array | null = null;

  constructor(opts: FlowResultGridOptions) {
    this._onActivate = opts.onActivate;
    this._onMove = opts.onMove;
    this._elevationRef = opts.elevationRef ?? null;

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'olv-flow-grid-canvas';
    this._canvas.tabIndex = 0;
    this._canvas.setAttribute('role', 'application');
    this._canvas.setAttribute('aria-label', opts.ariaLabel);

    this._status = document.createElement('div');
    this._status.className = 'olv-flow-grid-status';

    this.element = document.createElement('div');
    this.element.className = 'olv-flow-grid';
    this.element.append(this._canvas, this._status);

    this._canvas.addEventListener('click', (e) => this._handleClick(e));
    this._canvas.addEventListener('keydown', (e) => this._handleKey(e));
  }

  focus(): void {
    this._canvas.focus();
  }

  get cursor(): GridCell {
    return this._cursor;
  }

  /** Load a freshly-routed field and redraw from (0, 0). Clears any path/catchment mask. */
  load(grid: FlowGrid, routed: D8Result, accumulation: AccumulationResult, areaM2: Float64Array | null): void {
    this._grid = grid;
    this._routed = routed;
    this._accumulation = accumulation;
    this._areaM2 = areaM2;
    this._pathMask = null;
    this._catchmentMask = null;
    this._cursor = clampCell(grid.cols, grid.rows, 0, 0);
    this._redraw();
    this._updateStatus(false);
  }

  /** Highlight a traced downstream path, or clear it with `null`. */
  setPathMask(mask: Uint8Array | null): void {
    this._pathMask = mask;
    this._redraw();
  }

  /** Highlight an upstream catchment, or clear it with `null`. */
  setCatchmentMask(mask: Uint8Array | null): void {
    this._catchmentMask = mask;
    this._redraw();
  }

  private _handleClick(e: MouseEvent): void {
    if (!this._grid) return;
    const rect = this._canvas.getBoundingClientRect();
    const cell = pixelToCell(
      this._grid.cols, this._grid.rows, rect.width, rect.height,
      e.clientX - rect.left, e.clientY - rect.top,
    );
    if (!cell) return;
    this._cursor = cell;
    this._redraw();
    this._updateStatus(true);
    this._onActivate(cell);
  }

  private _handleKey(e: KeyboardEvent): void {
    if (!this._grid) return;
    const { cols, rows } = this._grid;
    let moved: GridCell | null = null;
    switch (e.key) {
      case 'ArrowLeft': moved = moveCursor(cols, rows, this._cursor, -1, 0); break;
      case 'ArrowRight': moved = moveCursor(cols, rows, this._cursor, 1, 0); break;
      case 'ArrowUp': moved = moveCursor(cols, rows, this._cursor, 0, -1); break;
      case 'ArrowDown': moved = moveCursor(cols, rows, this._cursor, 0, 1); break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this._updateStatus(true);
        this._onActivate(this._cursor);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (moved.col === this._cursor.col && moved.row === this._cursor.row) return;
    this._cursor = moved;
    this._redraw();
    this._updateStatus(false);
  }

  private _updateStatus(activated: boolean): void {
    if (!this._grid || !this._routed || !this._accumulation) return;
    const report = describeCell(
      this._grid, this._routed, this._accumulation, this._areaM2, this._cursor, this._elevationRef,
    );
    this._status.textContent = `${activated ? 'Selected — ' : ''}${cellAnnouncement(report)}`;
    this._onMove(this._cursor, report);
  }

  private _redraw(): void {
    const grid = this._grid;
    const routed = this._routed;
    if (!grid || !routed) return;
    const scale = Math.max(1, Math.floor(CANVAS_MAX / Math.max(grid.cols, grid.rows)));
    const w = grid.cols * scale;
    const h = grid.rows * scale;
    this._canvas.width = w;
    this._canvas.height = h;
    this._canvas.style.width = `${w}px`;
    this._canvas.style.height = `${h}px`;
    // No canvas 2D context under the Node unit-test DOM shim (no `getContext` at
    // all) or in a headless environment without one: the cursor/status state this
    // module is actually tested on lives in `_cursor` and `_status.textContent`,
    // neither of which needs a paint. A real browser always has one.
    const ctx = typeof this._canvas.getContext === 'function' ? this._canvas.getContext('2d') : null;
    if (!ctx) return;

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const i = row * grid.cols + col;
        const status = routed.status[i];
        ctx.fillStyle = STATUS_COLOR[status] ?? (status === 2 /* CELL_FLAT */ ? FLAT_COLOR : ROUTED_COLOR);
        ctx.fillRect(col * scale, row * scale, scale, scale);
      }
    }
    if (this._catchmentMask) {
      ctx.fillStyle = 'rgba(255, 165, 60, 0.55)';
      for (let i = 0; i < this._catchmentMask.length; i++) {
        if (this._catchmentMask[i] !== 1) continue;
        const col = i % grid.cols, row = Math.floor(i / grid.cols);
        ctx.fillRect(col * scale, row * scale, scale, scale);
      }
    }
    if (this._pathMask) {
      ctx.fillStyle = 'rgba(250, 243, 89, 0.9)';
      for (let i = 0; i < this._pathMask.length; i++) {
        if (this._pathMask[i] !== 1) continue;
        const col = i % grid.cols, row = Math.floor(i / grid.cols);
        ctx.fillRect(col * scale, row * scale, scale, scale);
      }
    }
    // Cursor outline, always drawn last.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, Math.floor(scale / 6));
    ctx.strokeRect(
      this._cursor.col * scale + ctx.lineWidth / 2,
      this._cursor.row * scale + ctx.lineWidth / 2,
      scale - ctx.lineWidth,
      scale - ctx.lineWidth,
    );
  }
}

/** Build a 1-bit mask from a cell-index array, for {@link FlowResultGrid.setPathMask}. */
export function maskFromIndices(n: number, indices: ArrayLike<number>): Uint8Array {
  const mask = new Uint8Array(n);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (i >= 0 && i < n) mask[i] = 1;
  }
  return mask;
}

export { cellIndex };
