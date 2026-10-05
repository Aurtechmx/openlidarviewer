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
  clampCell,
  moveCursor,
  pixelToCell,
  describeTerrainAccessCell,
  terrainAccessCellAnnouncement,
  type ElevationReference,
  type GridCell,
  type TerrainAccessCellReport,
} from '../../simulation/terrainAccess/terrainAccessGridCursor';
import { buildResultGridDom } from './resultGridDom';
import { el } from '../dom';
import { TERRAIN_ACCESS_STATE_LABEL, costBucketNote } from '../../simulation/terrainAccess/terrainAccessExplain';
import { maskFromIndices as sharedMaskFromIndices } from './gridMask';
import { MAP_COST_BUCKETS, type TraversabilityMapCell } from '../../simulation/terrainAccess/traversabilityCost';
import { cividis, prefersReducedMotion, rampGradient, rgbCss } from './labColormaps';
import {
  LAB_BLOCKED, LAB_LINE, LAB_WITHHELD, casedPath, cellCentres, dotCell, drawIn, hatchCell, letteredRing,
} from './labGridPaint';
import type { TerrainAccessGrid } from '../../simulation/terrainAccess/terrainAccessTypes';

const CANVAS_MAX = 320;

export interface TerrainAccessResultGridOptions {
  readonly ariaLabel: string;
  /** A cell was activated — a click, or Enter/Space on the keyboard cursor. */
  readonly onActivate: (cell: GridCell) => void;
  /** The keyboard/pointer cursor moved to a new cell (no activation). */
  readonly onMove: (cell: GridCell, report: TerrainAccessCellReport) => void;
  /** How to recover a real elevation from the grid's local z; see `flowResultGrid.ts`'s
   * option of the same name. Absent/null: every cell reports elevation 'unknown'. */
  readonly elevationRef?: ElevationReference | null;
}

/** The cost ramp spans 0 to 100 % extra cost; anything dearer takes the top colour. */
const COST_RAMP_MAX = 1;
const costT = (multiplier: number): number => multiplier / COST_RAMP_MAX;

const START_COLOR = '#38bdf8';
const GOAL_COLOR = '#f0abfc';
const ROUTE_COLOR = LAB_LINE;
const ROUTE_DRAW_MS = 600;

function patternSwatch(kind: 'hatch' | 'dots' | 'line' | 'ring', glyph: string, label: string, color: string): HTMLElement {
  const swatch = el('span', { className: `olv-lab-swatch olv-lab-swatch--${kind}` });
  swatch.style.color = color;
  return el('li', { className: 'olv-lab-legend-item' }, [
    swatch,
    el('span', { className: 'olv-lab-legend-glyph', text: glyph }),
    el('span', { text: label }),
  ]);
}

/** The map's legend: the cividis cost ramp with its unit and bucket edges, the
 * patterns for cells off the ramp, and the route marks, each with a glyph and
 * the state name the cursor readout also uses. */
export function terrainAccessGridLegend(): HTMLElement {
  const label = TERRAIN_ACCESS_STATE_LABEL;
  const low = MAP_COST_BUCKETS.low, mod = MAP_COST_BUCKETS.moderate;
  const bar = el('div', { className: 'olv-lab-ramp-bar' });
  bar.style.background = rampGradient(cividis);
  const ticks = el('div', { className: 'olv-lab-ramp-ticks' }, [
    [0, '0'], [low, `${Math.round(low * 100)}`], [mod, `${Math.round(mod * 100)}`], [COST_RAMP_MAX, '≥100'],
  ].map(([at, text]) => {
    const t = el('span', { className: 'olv-lab-ramp-tick', text: String(text) });
    t.style.left = `${(Number(at) / COST_RAMP_MAX) * 100}%`;
    return t;
  }));
  const ramp = el('div', { className: 'olv-lab-ramp' }, [
    el('p', { className: 'olv-lab-ramp-title', text: 'Extra cost over a flat, supported move (%)' }),
    bar,
    ticks,
  ]);
  ramp.setAttribute('role', 'img');
  ramp.setAttribute('aria-label', 'Cost colour scale, cividis: dark blue is 0 % extra cost, yellow is 100 % or more.');
  const bucket = (state: 'low-cost' | 'moderate-cost' | 'high-cost', from: number, to: number, range: string): HTMLElement => {
    const sw = el('span', { className: 'olv-lab-swatch' });
    sw.style.background = rgbCss(cividis(costT((from + to) / 2)));
    return el('li', { className: 'olv-lab-legend-item' }, [
      sw,
      el('span', { text: label[state] }), el('span', { className: 'olv-lab-legend-range', text: range }),
    ]);
  };
  const buckets = el('ul', { className: 'olv-lab-legend', ariaLabel: 'Cost buckets' }, [
    bucket('low-cost', 0, low, `≤ ${Math.round(low * 100)} %`),
    bucket('moderate-cost', low, mod, `≤ ${Math.round(mod * 100)} %`),
    bucket('high-cost', mod, COST_RAMP_MAX, `> ${Math.round(mod * 100)} %`),
  ]);
  const marks = el('ul', { className: 'olv-lab-legend', ariaLabel: 'Map legend' }, [
    patternSwatch('hatch', '✕', label.blocked, LAB_BLOCKED),
    patternSwatch('dots', '?', label.unknown, LAB_WITHHELD),
    patternSwatch('line', '━', 'Route', ROUTE_COLOR),
    patternSwatch('ring', 'S', 'Start', START_COLOR),
    patternSwatch('ring', 'G', 'Goal', GOAL_COLOR),
  ]);
  return el('div', { className: 'olv-ta-legend olv-lab-legend-panel' }, [
    ramp, buckets, marks,
    el('p', { className: 'olv-ta-legend-note', text: costBucketNote() }),
  ]);
}

export class TerrainAccessResultGrid {
  readonly element: HTMLElement;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _status: HTMLElement;
  private readonly _onActivate: TerrainAccessResultGridOptions['onActivate'];
  private readonly _onMove: TerrainAccessResultGridOptions['onMove'];
  private readonly _elevationRef: ElevationReference | null;

  private _grid: TerrainAccessGrid | null = null;
  private _map: readonly TraversabilityMapCell[] | null = null;
  private _cursor: GridCell = { col: 0, row: 0 };
  private _start: GridCell | null = null;
  private _goal: GridCell | null = null;
  private _routeMask: Uint8Array | null = null;
  private _routeOrder: ArrayLike<number> | null = null;
  private _routeFraction = 1;
  private _cancelDraw: () => void = () => {};

  constructor(opts: TerrainAccessResultGridOptions) {
    this._onActivate = opts.onActivate;
    this._onMove = opts.onMove;
    this._elevationRef = opts.elevationRef ?? null;

    const dom = buildResultGridDom({
      ariaLabel: opts.ariaLabel,
      wrapClassName: 'olv-ta-grid',
      canvasClassName: 'olv-ta-grid-canvas',
      statusClassName: 'olv-ta-grid-status',
      onClick: (e) => this._handleClick(e),
      onKeyDown: (e) => this._handleKey(e),
    });
    this.element = dom.element;
    this._canvas = dom.canvas;
    this._status = dom.status;
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
    this._cancelDraw();
    this._routeMask = null;
    this._routeOrder = null;
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

  /**
   * Highlight a found route, or clear it with `null`. With `order` (the route's
   * cell indices from start to goal) the route is drawn as a line that draws in
   * from the start, or at once under reduced motion.
   */
  setRouteMask(mask: Uint8Array | null, order: ArrayLike<number> | null = null): void {
    this._cancelDraw();
    this._routeMask = mask;
    this._routeOrder = mask ? order : null;
    if (!mask || !order) {
      this._routeFraction = 1;
      this._redraw();
      return;
    }
    this._cancelDraw = drawIn(ROUTE_DRAW_MS, prefersReducedMotion(), (f) => {
      this._routeFraction = f;
      this._redraw();
    });
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
    const report = describeTerrainAccessCell(this._grid, this._map, this._cursor, this._elevationRef);
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
    // Width only: CSS max-width can narrow the canvas, and a fixed pixel
    // height would then stretch every cell. Auto height keeps cells square.
    this._canvas.style.width = `${w}px`;
    this._canvas.style.height = 'auto';
    this._canvas.style.aspectRatio = `${w} / ${h}`;
    // No canvas 2D context under the Node unit-test DOM shim, matching
    // `flowResultGrid.ts`'s own note: the tested state lives in `_cursor` and
    // `_status.textContent`, neither of which needs a paint.
    const ctx = typeof this._canvas.getContext === 'function' ? this._canvas.getContext('2d') : null;
    if (!ctx) return;

    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 1 ? Math.min(3, devicePixelRatio) : 1;
    if (dpr !== 1) {
      this._canvas.width = w * dpr;
      this._canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
    }
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const cell = map[row * grid.cols + col]!;
        const x = col * scale, y = row * scale;
        if (cell.state === 'blocked') hatchCell(ctx, x, y, scale, LAB_BLOCKED);
        else if (cell.state === 'unknown' || cell.bestMultiplier === null) dotCell(ctx, x, y, scale, LAB_WITHHELD);
        else {
          ctx.fillStyle = rgbCss(cividis(costT(cell.bestMultiplier)));
          ctx.fillRect(x, y, scale, scale);
        }
      }
    }
    if (this._routeMask && this._routeOrder) {
      casedPath(ctx, cellCentres(this._routeOrder, grid.cols, scale), scale, ROUTE_COLOR, this._routeFraction);
    } else if (this._routeMask) {
      ctx.fillStyle = ROUTE_COLOR;
      for (let i = 0; i < this._routeMask.length; i++) {
        if (this._routeMask[i] !== 1) continue;
        const col = i % grid.cols, row = Math.floor(i / grid.cols);
        ctx.fillRect(col * scale + scale / 3, row * scale + scale / 3, scale / 3, scale / 3);
      }
    }
    if (this._start) letteredRing(ctx, this._start.col, this._start.row, scale, START_COLOR, 'S');
    if (this._goal) letteredRing(ctx, this._goal.col, this._goal.row, scale, GOAL_COLOR, 'G');
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
export const maskFromIndices = sharedMaskFromIndices;

export { cellIndex } from '../../simulation/terrainAccess/terrainAccessGridCursor';
