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
import { northBadge } from './labStats';
import { cividis, prefersReducedMotion, rampGradient, rgbCss } from './labColormaps';
import {
  LAB_BLOCKED, LAB_LINE, LAB_WITHHELD, casedPath, cellBorders, cellCentres, cellSpan, dotCell, drawIn, fitGridCanvas,
  hatchCell, letteredRing, northUpCell, northUpRowStep, onWidthChange,
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
  // The bucket band sits under the ramp: each segment spans its bucket's cost
  // range, so the 15 and 50 ticks are the segment edges.
  const segment = (state: 'low-cost' | 'moderate-cost' | 'high-cost', from: number, to: number, range: string): HTMLElement => {
    const seg = el('li', { className: 'olv-lab-bucket' }, [
      el('span', { className: 'olv-lab-bucket-name', text: label[state] }),
      el('span', { className: 'olv-lab-legend-range', text: range }),
    ]);
    seg.style.flexGrow = String(Math.round((to - from) * 100));
    seg.style.setProperty?.('--bucket-ink', rgbCss(cividis(costT((from + to) / 2))));
    return seg;
  };
  const band = el('ul', { className: 'olv-lab-buckets', ariaLabel: 'Cost buckets' }, [
    segment('low-cost', 0, low, `≤ ${Math.round(low * 100)} %`),
    segment('moderate-cost', low, mod, `≤ ${Math.round(mod * 100)} %`),
    segment('high-cost', mod, COST_RAMP_MAX, `> ${Math.round(mod * 100)} %`),
  ]);
  const ramp = el('div', { className: 'olv-lab-ramp' }, [
    el('p', { className: 'olv-lab-ramp-title', text: 'Extra cost over a flat, supported move (%)' }),
    bar,
    ticks,
    band,
  ]);
  ramp.setAttribute('role', 'group');
  ramp.setAttribute('aria-label', 'Cost colour scale, cividis: dark blue is 0 % extra cost, yellow is 100 % or more.');
  const marks = el('ul', { className: 'olv-lab-legend', ariaLabel: 'Map legend' }, [
    patternSwatch('hatch', '✕', label.blocked, LAB_BLOCKED),
    patternSwatch('dots', '?', label.unknown, LAB_WITHHELD),
    patternSwatch('line', '━', 'Route', ROUTE_COLOR),
    patternSwatch('ring', 'S', 'Start', START_COLOR),
    patternSwatch('ring', 'G', 'Goal', GOAL_COLOR),
  ]);
  return el('div', { className: 'olv-ta-legend olv-lab-legend-panel' }, [
    ramp, marks,
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
  private readonly _stopResize: () => void;

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
    // One stage holds the canvas and its north arrow.
    const stage = el('div', { className: 'olv-lab-stage' });
    stage.append(this._canvas, northBadge());
    this.element.replaceChildren(stage, this._status);
    this._stopResize = onWidthChange(this._canvas, () => this._redraw());
  }

  focus(): void {
    this._canvas.focus();
  }

  /** Stop a route draw-in and the resize observer. */
  dispose(): void {
    this._cancelDraw();
    this._stopResize();
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
    const cell = northUpCell(
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
      case 'ArrowUp':
      case 'ArrowDown': moved = moveCursor(cols, rows, this._cursor, 0, northUpRowStep(e.key)); break;
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
    // Cells stay square: the CSS aspect ratio follows cols x rows, the width
    // fills the column, and the buffer is sized from the laid-out width.
    const styleScale = Math.max(1, Math.floor(CANVAS_MAX / Math.max(grid.cols, grid.rows)));
    const fit = fitGridCanvas(this._canvas, grid.cols, grid.rows, styleScale);
    if (!fit) return;
    const { ctx, s } = fit;

    for (let row = 0; row < grid.rows; row++) {
      const [y, ch] = cellSpan(row, s);
      for (let col = 0; col < grid.cols; col++) {
        const [x, cw] = cellSpan(col, s);
        const cell = map[row * grid.cols + col]!;
        if (cell.state === 'blocked') hatchCell(ctx, x, y, Math.max(cw, ch), LAB_BLOCKED);
        else if (cell.state === 'unknown' || cell.bestMultiplier === null) dotCell(ctx, x, y, Math.max(cw, ch), LAB_WITHHELD);
        else {
          ctx.fillStyle = rgbCss(cividis(costT(cell.bestMultiplier)));
          ctx.fillRect(x, y, cw, ch);
        }
      }
    }
    cellBorders(ctx, grid.cols, grid.rows, s);
    if (this._routeMask && this._routeOrder) {
      casedPath(ctx, cellCentres(this._routeOrder, grid.cols, s), s, ROUTE_COLOR, this._routeFraction);
    } else if (this._routeMask) {
      ctx.fillStyle = ROUTE_COLOR;
      for (let i = 0; i < this._routeMask.length; i++) {
        if (this._routeMask[i] !== 1) continue;
        ctx.fillRect((i % grid.cols) * s + s / 3, Math.floor(i / grid.cols) * s + s / 3, s / 3, s / 3);
      }
    }
    // Endpoints last but for the cursor, so a route never covers them.
    if (this._start) letteredRing(ctx, this._start.col, this._start.row, s, START_COLOR, 'S');
    if (this._goal) letteredRing(ctx, this._goal.col, this._goal.row, s, GOAL_COLOR, 'G');
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, Math.floor(s / 8));
    ctx.strokeRect(
      this._cursor.col * s + ctx.lineWidth / 2,
      this._cursor.row * s + ctx.lineWidth / 2,
      s - ctx.lineWidth,
      s - ctx.lineWidth,
    );
  }
}

/** Build a 1-bit mask from a cell-index array, for {@link TerrainAccessResultGrid.setRouteMask}. */
export const maskFromIndices = sharedMaskFromIndices;

export { cellIndex } from '../../simulation/terrainAccess/terrainAccessGridCursor';
