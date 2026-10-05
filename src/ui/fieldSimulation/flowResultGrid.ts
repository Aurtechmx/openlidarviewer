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
  type CellReport,
  type ElevationReference,
  type GridCell,
} from '../../simulation/flowPulse/flowGridCursor';
import { CELL_FLAT, CELL_NODATA, CELL_OUTLET, CELL_SINK } from '../../simulation/flowPulse/flowTypes';
import { logScale } from '../../render/flowOverlayGeometry';
import { el } from '../dom';
import { prefersReducedMotion, rampGradient, rgbCss, viridis } from './labColormaps';
import {
  LAB_LINE, LAB_WITHHELD, casedPath, cellBorders, cellCentres, cellSpan, dotCell, drawIn, fitGridCanvas, northUpCell, northUpRowStep, onWidthChange,
} from './labGridPaint';
import { FlowParticles } from './flowParticles';
import { northBadge } from './labStats';
import { buildResultGridDom } from './resultGridDom';
import { legend } from '../labGuide';
import { maskFromIndices as sharedMaskFromIndices } from './gridMask';
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
const PATH_COLOR = LAB_LINE;
const CATCHMENT_COLOR = '#ffffff';
const OUTLET_COLOR = '#38bdf8';
const SINK_COLOR = '#f0abfc';
const PATH_DRAW_MS = 600;
/** How much the hillshade darkens a cell: 0 keeps the ramp colour, 1 is full shade. */
const HILLSHADE_WEIGHT = 0.35;

/** Tick values for a log upstream-count ramp: 1, then powers of ten below the maximum, then the maximum. */
export function upstreamTicks(max: number): number[] {
  const m = Math.max(1, Math.round(max));
  const ticks = [1];
  for (let v = 10; v < m; v *= 10) if (logScale(v, m) < 0.8) ticks.push(v);
  if (m > 1) ticks.push(m);
  return ticks;
}

/**
 * Lambertian hillshade per cell from the grid's own elevations, sun at
 * azimuth 315 deg (north-west), altitude 45 deg, in [0, 1]. Row 0 is the
 * southern row, so rows increase northwards. NoData and edge-adjacent
 * NoData neighbours fall back to the centre cell's elevation.
 */
export function hillshade(grid: FlowGrid): Float32Array {
  const { cols, rows, z, valid } = grid;
  const out = new Float32Array(cols * rows);
  // Compass azimuth 315 deg in the math convention the aspect formula uses (360 - az + 90).
  const zen = Math.PI / 4, az = (135 * Math.PI) / 180;
  const at = (c: number, r: number, fallback: number): number => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return fallback;
    const i = r * cols + c;
    return valid[i] ? z[i]! : fallback;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!valid[i]) continue;
      const z0 = z[i]!;
      const dzdx = (at(c + 1, r, z0) - at(c - 1, r, z0)) / (2 * grid.cellMetresX);
      // Horn's dz/dy runs north to south; rows here run south to north.
      const dzdy = (at(c, r - 1, z0) - at(c, r + 1, z0)) / (2 * grid.cellMetresY);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const v = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
      out[i] = Math.min(1, Math.max(0, v));
    }
  }
  return out;
}

function markItem(kind: 'hatch' | 'dots' | 'line' | 'ring' | 'dash', glyph: string, label: string, color: string): HTMLElement {
  const swatch = el('span', { className: `olv-lab-swatch olv-lab-swatch--${kind}` });
  swatch.style.color = color;
  return el('li', { className: 'olv-lab-legend-item' }, [
    swatch,
    el('span', { className: 'olv-lab-legend-glyph', text: glyph }),
    el('span', { text: label }),
  ]);
}

/**
 * The grid legend: the viridis upstream-count ramp on its log scale, with
 * ticks at powers of ten up to `maxUpstream`, then the marks drawn over it.
 */
export function flowGridLegend(maxUpstream = 1): HTMLElement {
  const max = Math.max(1, Math.round(maxUpstream));
  const bar = el('div', { className: 'olv-lab-ramp-bar' });
  bar.style.background = rampGradient(viridis);
  const ticks = el('div', { className: 'olv-lab-ramp-ticks' }, upstreamTicks(max).map((v) => {
    const t = el('span', { className: 'olv-lab-ramp-tick', text: v.toLocaleString('en-US') });
    t.style.left = `${logScale(v, max) * 100}%`;
    return t;
  }));
  const ramp = el('div', { className: 'olv-lab-ramp' }, [
    el('p', { className: 'olv-lab-ramp-title', text: 'Upstream cells draining through a cell (log scale)' }),
    bar,
    ticks,
  ]);
  ramp.setAttribute('role', 'img');
  ramp.setAttribute('aria-label', `Upstream-cell colour scale, viridis on a log scale: dark purple is 1 cell, yellow is ${max.toLocaleString('en-US')} cells. Relief shading darkens cells facing away from a north-west light.`);
  const marks = legend('Grid legend', []);
  marks.append(
    markItem('line', '━', 'Path', PATH_COLOR),
    markItem('dash', '┅', 'Catchment edge', CATCHMENT_COLOR),
    markItem('ring', '○', 'Outlet (flow leaves the grid)', OUTLET_COLOR),
    markItem('ring', '▼', 'Sink (flow stops)', SINK_COLOR),
    markItem('dash', '–', 'Flat', LAB_LINE),
    markItem('dots', '?', 'No ground data', LAB_WITHHELD),
  );
  return el('div', { className: 'olv-flow-legend olv-lab-legend-panel' }, [ramp, marks]);
}

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
  private _pathOrder: ArrayLike<number> | null = null;
  private _pathFraction = 1;
  private _cancelDraw: () => void = () => {};
  private _shade: Float32Array | null = null;
  private _maxUpstream = 1;
  /** Moving marks along the D8 directions; see flowParticles.ts. */
  readonly particles: FlowParticles;

  constructor(opts: FlowResultGridOptions) {
    this._onActivate = opts.onActivate;
    this._onMove = opts.onMove;
    this._elevationRef = opts.elevationRef ?? null;

    const dom = buildResultGridDom({
      ariaLabel: opts.ariaLabel,
      wrapClassName: 'olv-flow-grid',
      canvasClassName: 'olv-flow-grid-canvas',
      statusClassName: 'olv-flow-grid-status',
      onClick: (e) => this._handleClick(e),
      onKeyDown: (e) => this._handleKey(e),
    });
    this.element = dom.element;
    this._canvas = dom.canvas;
    this._status = dom.status;
    // The particle canvas sits over the grid canvas in one stage; it takes no
    // pointer events, so clicks and keys still reach the grid.
    this.particles = new FlowParticles();
    const stage = el('div', { className: 'olv-lab-stage' });
    stage.append(this._canvas, this.particles.canvas, northBadge());
    this.element.replaceChildren(stage, this._status);
    onWidthChange(this._canvas, () => this._redraw());
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
    this._cancelDraw();
    this._pathMask = null;
    this._pathOrder = null;
    this._catchmentMask = null;
    this._shade = hillshade(grid);
    let max = 1;
    for (const v of accumulation.upstreamCells) if (v > max) max = v;
    this._maxUpstream = max;
    this.particles.load({
      cols: grid.cols, rows: grid.rows, receiver: routed.receiver,
      upstreamCells: accumulation.upstreamCells, maxUpstream: max,
    });
    this._cursor = clampCell(grid.cols, grid.rows, 0, 0);
    this._redraw();
    this._updateStatus(false);
  }

  /** The largest upstream count on the loaded grid, for the legend's scale. */
  get maxUpstream(): number {
    return this._maxUpstream;
  }

  /**
   * Highlight a traced downstream path, or clear it with `null`. With `order`
   * (the path's cell indices, downstream) it draws in from the picked cell, or
   * at once under reduced motion.
   */
  setPathMask(mask: Uint8Array | null, order: ArrayLike<number> | null = null): void {
    this._cancelDraw();
    this._pathMask = mask;
    this._pathOrder = mask ? order : null;
    if (!mask || !order) {
      this._pathFraction = 1;
      this._redraw();
      return;
    }
    this._cancelDraw = drawIn(PATH_DRAW_MS, prefersReducedMotion(), (f) => {
      this._pathFraction = f;
      this._redraw();
    });
  }

  /** Highlight an upstream catchment, or clear it with `null`. */
  setCatchmentMask(mask: Uint8Array | null): void {
    this._catchmentMask = mask;
    this._redraw();
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
      case 'ArrowUp':
      case 'ArrowDown': moved = moveCursor(cols, rows, this._cursor, 0, northUpRowStep(e.key)); break;
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
    // Square cells filling the column, buffer sized from the laid-out width.
    const styleScale = Math.max(1, Math.floor(CANVAS_MAX / Math.max(grid.cols, grid.rows)));
    const fit = fitGridCanvas(this._canvas, grid.cols, grid.rows, styleScale);
    if (!fit) return;
    const { ctx, s: scale } = fit;
    const acc = this._accumulation;
    const shade = this._shade;
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const i = row * grid.cols + col;
        const [x, cw] = cellSpan(col, scale);
        const [y, ch] = cellSpan(row, scale);
        if (routed.status[i] === CELL_NODATA) { dotCell(ctx, x, y, Math.max(cw, ch), LAB_WITHHELD); continue; }
        const c = viridis(acc ? logScale(acc.upstreamCells[i]!, this._maxUpstream) : 0);
        const k = shade ? 1 - HILLSHADE_WEIGHT * (1 - shade[i]!) : 1;
        ctx.fillStyle = rgbCss([Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)]);
        ctx.fillRect(x, y, cw, ch);
      }
    }
    cellBorders(ctx, grid.cols, grid.rows, scale);
    if (this._catchmentMask) this._strokeMaskEdge(ctx, grid, this._catchmentMask, scale);
    if (this._pathMask && this._pathOrder) {
      casedPath(ctx, cellCentres(this._pathOrder, grid.cols, scale), scale, PATH_COLOR, this._pathFraction);
    } else if (this._pathMask) {
      ctx.fillStyle = PATH_COLOR;
      for (let i = 0; i < this._pathMask.length; i++) {
        if (this._pathMask[i] !== 1) continue;
        ctx.fillRect((i % grid.cols) * scale + scale / 3, Math.floor(i / grid.cols) * scale + scale / 3, scale / 3, scale / 3);
      }
    }
    this._drawStatusMarks(ctx, grid, routed.status, scale);
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

  /** Dashed outline along the edges where the mask meets a cell outside it. */
  private _strokeMaskEdge(ctx: CanvasRenderingContext2D, grid: FlowGrid, mask: Uint8Array, s: number): void {
    const inside = (c: number, r: number): boolean =>
      c >= 0 && r >= 0 && c < grid.cols && r < grid.rows && mask[r * grid.cols + c] === 1;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.strokeStyle = CATCHMENT_COLOR;
    ctx.lineWidth = Math.max(1, s / 8);
    ctx.setLineDash([Math.max(2, s / 3), Math.max(2, s / 4)]);
    ctx.beginPath();
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        if (!inside(c, r)) continue;
        const x = c * s, y = r * s;
        ctx.fillRect(x, y, s, s);
        if (!inside(c, r - 1)) { ctx.moveTo(x, y); ctx.lineTo(x + s, y); }
        if (!inside(c, r + 1)) { ctx.moveTo(x, y + s); ctx.lineTo(x + s, y + s); }
        if (!inside(c - 1, r)) { ctx.moveTo(x, y); ctx.lineTo(x, y + s); }
        if (!inside(c + 1, r)) { ctx.moveTo(x + s, y); ctx.lineTo(x + s, y + s); }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Outlets as open rings, sinks as filled down-triangles, flats as a short dash. */
  private _drawStatusMarks(ctx: CanvasRenderingContext2D, grid: FlowGrid, status: ArrayLike<number>, s: number): void {
    if (s < 4) return;
    ctx.save();
    ctx.lineWidth = Math.max(1, s / 8);
    for (let i = 0; i < grid.cols * grid.rows; i++) {
      const st = status[i];
      if (st !== CELL_OUTLET && st !== CELL_SINK && st !== CELL_FLAT) continue;
      const cx = (i % grid.cols) * s + s / 2, cy = Math.floor(i / grid.cols) * s + s / 2, r = s * 0.32;
      ctx.beginPath();
      if (st === CELL_OUTLET) {
        ctx.strokeStyle = OUTLET_COLOR;
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      } else if (st === CELL_SINK) {
        ctx.fillStyle = SINK_COLOR;
        ctx.moveTo(cx - r, cy - r * 0.7); ctx.lineTo(cx + r, cy - r * 0.7); ctx.lineTo(cx, cy + r * 0.9);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.strokeStyle = LAB_LINE;
        ctx.moveTo(cx - r * 0.7, cy); ctx.lineTo(cx + r * 0.7, cy);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** Build a 1-bit mask from a cell-index array, for {@link FlowResultGrid.setPathMask}. */
export const maskFromIndices = sharedMaskFromIndices;

export { cellIndex };
