/**
 * terrainAccessResultGrid.ts — the keyboard- and pointer-accessible stand-in
 * for clicking the scan, for Terrain Access.
 *
 * Mirrors `flowResultGrid.ts`'s reasoning exactly: `Viewer.ts` has no picking
 * seam a lazy feature can reach without growing the monolith, so start/goal
 * selection, the found route and the why-not inspector all read a small
 * canvas raster of the routed grid instead. A click and an Enter/Space
 * activation are the same event to a listener; which one fires depends on the
 * Lab's current mode ('start' / 'goal' / 'inspect'), owned by the caller, not
 * this module.
 *
 * The canvas is a picture for a sighted pointer user; the plain-text status
 * line (and the caller's live region) carry the cell's identity for a screen
 * reader. Pixel colour is not load-bearing for any behaviour this module is
 * tested on — cursor state and the status line are.
 */

import {
  cellIndex,
  clampCell,
  moveCursor,
  pixelToCell,
  describeTerrainAccessCell,
  terrainAccessCellAnnouncement,
  type GridCell,
  type TerrainAccessCellReport,
} from '../../simulation/terrainAccess/terrainAccessGridCursor';
import type { TraversabilityMapCell } from '../../simulation/terrainAccess/traversabilityCost';
import type { TerrainAccessGrid } from '../../simulation/terrainAccess/terrainAccessTypes';

const CANVAS_MAX = 320;

export interface TerrainAccessResultGridOptions {
  readonly ariaLabel: string;
  /** A cell was activated — a click, or Enter/Space on the keyboard cursor. */
  readonly onActivate: (cell: GridCell) => void;
  /** The keyboard/pointer cursor moved to a new cell (no activation). */
  readonly onMove: (cell: GridCell, report: TerrainAccessCellReport) => void;
}

/** Flat, colourblind-legible bucket colours — a glance-level classification, not data. */
const STATE_COLOR: Record<TraversabilityMapCell['state'], string> = {
  blocked: '#5b2b2b',
  unknown: '#1c1f26',
  'low-cost': '#3a7a4a',
  'moderate-cost': '#8a7d3a',
  'high-cost': '#a24f2b',
};

const START_COLOR = '#5b9dc2';
const GOAL_COLOR = '#c25bb0';
const ROUTE_COLOR = 'rgba(250, 243, 89, 0.9)';

export class TerrainAccessResultGrid {
  readonly element: HTMLElement;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _status: HTMLElement;
  private readonly _onActivate: TerrainAccessResultGridOptions['onActivate'];
  private readonly _onMove: TerrainAccessResultGridOptions['onMove'];

  private _grid: TerrainAccessGrid | null = null;
  private _map: readonly TraversabilityMapCell[] | null = null;
  private _cursor: GridCell = { col: 0, row: 0 };
  private _start: GridCell | null = null;
  private _goal: GridCell | null = null;
  private _routeMask: Uint8Array | null = null;

  constructor(opts: TerrainAccessResultGridOptions) {
    this._onActivate = opts.onActivate;
    this._onMove = opts.onMove;

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'olv-ta-grid-canvas';
    this._canvas.tabIndex = 0;
    this._canvas.setAttribute('role', 'application');
    this._canvas.setAttribute('aria-label', opts.ariaLabel);

    this._status = document.createElement('div');
    this._status.className = 'olv-ta-grid-status';

    this.element = document.createElement('div');
    this.element.className = 'olv-ta-grid';
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

  /** Load a freshly-computed traversability map and redraw from (0, 0). Clears start/goal/route. */
  load(grid: TerrainAccessGrid, map: readonly TraversabilityMapCell[]): void {
    this._grid = grid;
    this._map = map;
    this._start = null;
    this._goal = null;
    this._routeMask = null;
    this._cursor = clampCell(grid.cols, grid.rows, 0, 0);
    this._redraw();
    this._updateStatus();
  }

  setStart(cell: GridCell | null): void {
    this._start = cell;
    this._redraw();
  }

  setGoal(cell: GridCell | null): void {
    this._goal = cell;
    this._redraw();
  }

  /** Highlight a found route, or clear it with `null`. */
  setRouteMask(mask: Uint8Array | null): void {
    this._routeMask = mask;
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
    this._updateStatus();
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
        this._onActivate(this._cursor);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (moved.col === this._cursor.col && moved.row === this._cursor.row) return;
    this._cursor = moved;
    this._redraw();
    this._updateStatus();
  }

  private _updateStatus(): void {
    if (!this._grid || !this._map) return;
    const report = describeTerrainAccessCell(this._grid, this._map, this._cursor);
    this._status.textContent = terrainAccessCellAnnouncement(report);
    this._onMove(this._cursor, report);
  }

  private _redraw(): void {
    const grid = this._grid;
    const map = this._map;
    if (!grid || !map) return;
    const scale = Math.max(1, Math.floor(CANVAS_MAX / Math.max(grid.cols, grid.rows)));
    const w = grid.cols * scale;
    const h = grid.rows * scale;
    this._canvas.width = w;
    this._canvas.height = h;
    this._canvas.style.width = `${w}px`;
    this._canvas.style.height = `${h}px`;
    // No canvas 2D context under the Node unit-test DOM shim, matching
    // `flowResultGrid.ts`'s own note: the tested state lives in `_cursor` and
    // `_status.textContent`, neither of which needs a paint.
    const ctx = typeof this._canvas.getContext === 'function' ? this._canvas.getContext('2d') : null;
    if (!ctx) return;

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const i = row * grid.cols + col;
        ctx.fillStyle = STATE_COLOR[map[i].state];
        ctx.fillRect(col * scale, row * scale, scale, scale);
      }
    }
    if (this._routeMask) {
      ctx.fillStyle = ROUTE_COLOR;
      for (let i = 0; i < this._routeMask.length; i++) {
        if (this._routeMask[i] !== 1) continue;
        const col = i % grid.cols, row = Math.floor(i / grid.cols);
        ctx.fillRect(col * scale, row * scale, scale, scale);
      }
    }
    if (this._start) {
      ctx.fillStyle = START_COLOR;
      ctx.fillRect(this._start.col * scale, this._start.row * scale, scale, scale);
    }
    if (this._goal) {
      ctx.fillStyle = GOAL_COLOR;
      ctx.fillRect(this._goal.col * scale, this._goal.row * scale, scale, scale);
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

/** Build a 1-bit mask from a cell-index array, for {@link TerrainAccessResultGrid.setRouteMask}. */
export function maskFromIndices(n: number, indices: ArrayLike<number>): Uint8Array {
  const mask = new Uint8Array(n);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (i >= 0 && i < n) mask[i] = 1;
  }
  return mask;
}

export { cellIndex };
