/**
 * LassoVolumeTool.ts
 *
 * Freehand lasso-on-canvas tool that drives the 3D volumetric volume
 * measurement.
 *
 * Mode of operation:
 *   1. `enable()` mounts a transparent SVG overlay on top of the canvas
 *      and attaches pointer-down / move / up handlers. The cursor flips
 *      to a crosshair.
 *   2. On pointerdown, a new lasso path starts; pointermove samples
 *      every input point and extends the polyline. The user sees a
 *      cyan path tracing their finger / mouse.
 *   3. On pointerup, the path is closed back to its first sample,
 *      `onCommit(lasso)` is invoked with the sampled vertices, and the
 *      tool stays armed (so the user can draw another lasso without
 *      re-toggling). `disable()` tears the overlay down.
 *
 * Escape cancels the in-progress lasso without firing `onCommit`. The
 * sampled vertices are CSS pixel coordinates relative to the canvas —
 * the same coordinate space `Viewer.computeLassoVolume` expects.
 */

import type { LassoSelectionBasis } from '../render/measure/lassoVolumeCompute';

/** A 2D point in CSS-pixel coordinates relative to the canvas. */
export interface LassoPoint {
  readonly x: number;
  readonly y: number;
}

/** Construction options. */
export interface LassoVolumeToolOptions {
  /**
   * Called when the user releases the pointer with a closed lasso of
   * at least 3 unique vertices. The tool stays enabled — call
   * `disable()` from inside the callback if you want a one-shot.
   *
   * `basis` is the selection basis armed at the moment of release, passed with
   * the path rather than read separately so the figure and the basis it was
   * measured on cannot be assembled from two different instants.
   */
  onCommit: (lasso: ReadonlyArray<LassoPoint>, basis: LassoSelectionBasis) => void;
  /** Called when the user hits Escape mid-draw. Defaults to a no-op. */
  onCancel?: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The lasso tool's lifecycle controller. */
export class LassoVolumeTool {
  private readonly _canvas: HTMLCanvasElement;
  private readonly _cb: LassoVolumeToolOptions;
  /** Transparent SVG overlay, mounted on top of the canvas during draw. */
  private _svg: SVGSVGElement | null = null;
  private _path: SVGPathElement | null = null;
  /** Current draw, in pointermove order. Cleared on commit/cancel. */
  private _points: LassoPoint[] = [];
  /** Canvas rect captured at pointerdown — fixed for the drag, so it isn't
   *  re-read (a forced reflow) on every pointermove. */
  private _dragRect: DOMRect | null = null;
  /** Accumulated `d` prefix (without the closing `Z`), grown one segment per
   *  sample so the path isn't rebuilt from scratch each move (was O(n²)). */
  private _pathD = '';
  /** True between pointerdown and pointerup. */
  private _drawing = false;
  /**
   * The selection basis every commit is taken on. Defaults to the basis every
   * lasso volume was measured on before the depth test existed, so arming the
   * tool and drawing the same shape gives the same number it always gave.
   */
  private _basis: LassoSelectionBasis = 'through-surfaces';
  /** Bound listeners so we can detach them on disable. */
  private readonly _onPointerDown: (e: PointerEvent) => void;
  private readonly _onPointerMove: (e: PointerEvent) => void;
  private readonly _onPointerUp: (e: PointerEvent) => void;
  private readonly _onKeyDown: (e: KeyboardEvent) => void;

  constructor(canvas: HTMLCanvasElement, options: LassoVolumeToolOptions) {
    this._canvas = canvas;
    this._cb = options;
    this._onPointerDown = (e) => this._handlePointerDown(e);
    this._onPointerMove = (e) => this._handlePointerMove(e);
    this._onPointerUp = (e) => this._handlePointerUp(e);
    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this._drawing) {
        this._abort();
      }
    };
  }

  /** Whether the tool is currently armed (SVG mounted, listeners attached). */
  get enabled(): boolean {
    return this._svg !== null;
  }

  /**
   * The selection basis the next commit will be taken on.
   *
   * Held here rather than read at the call site because it decides what a
   * measurement MEANS: `'occluded-excluded'` measures only surfaces the camera
   * can see, `'through-surfaces'` measures every depth along the ray, and the
   * two give different volumes for the same drawn shape.
   */
  get selectionBasis(): LassoSelectionBasis {
    return this._basis;
  }

  set selectionBasis(basis: LassoSelectionBasis) {
    this._basis = basis;
  }

  /**
   * Arm the tool — mount the SVG overlay over the canvas, flip the
   * cursor to a crosshair, and start listening for pointer events.
   * Safe to call when already enabled (no-op).
   */
  enable(): void {
    if (this._svg !== null) return;
    const parent = this._canvas.parentElement;
    if (!parent) return;
    this._svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this._svg.setAttribute('class', 'olv-lasso-svg');
    this._svg.setAttribute(
      'style',
      'position:absolute;inset:0;width:100%;height:100%;' +
        // Below `.olv-overlay` (--z-scene-overlay: 2), a stacking context holding
        // every panel: at 3 the armed lasso covered the UI and ate its clicks.
        'cursor:crosshair;z-index:var(--z-content);touch-action:none;',
    );
    this._path = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
    // Read the canonical accent token off :root so the lasso overlay
    // speaks the same colour language as the rest of the UI and tracks
    // theme switches (dark/light/high-contrast) instead of pinning the
    // dark-theme hex. Fallback guards a missing/empty custom property.
    const accent =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--accent')
        .trim() || '#00b2ff';
    this._path.setAttribute('fill', accent);
    this._path.setAttribute('fill-opacity', '0.1');
    this._path.setAttribute('stroke', accent);
    this._path.setAttribute('stroke-width', '1.5');
    this._path.setAttribute('stroke-dasharray', '5 4');
    this._path.setAttribute('stroke-linejoin', 'round');
    this._path.setAttribute('stroke-linecap', 'round');
    this._svg.append(this._path);
    parent.append(this._svg);

    this._svg.addEventListener('pointerdown', this._onPointerDown);
    this._svg.addEventListener('pointermove', this._onPointerMove);
    this._svg.addEventListener('pointerup', this._onPointerUp);
    this._svg.addEventListener('pointercancel', this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
  }

  /**
   * Tear the tool down — detach listeners, remove the SVG overlay,
   * clear any in-progress lasso. Safe to call when already disabled.
   */
  disable(): void {
    if (this._svg === null) return;
    this._svg.removeEventListener('pointerdown', this._onPointerDown);
    this._svg.removeEventListener('pointermove', this._onPointerMove);
    this._svg.removeEventListener('pointerup', this._onPointerUp);
    this._svg.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
    this._svg.remove();
    this._svg = null;
    this._path = null;
    this._points = [];
    this._drawing = false;
  }

  // ── Pointer handlers ────────────────────────────────────────────

  private _handlePointerDown(e: PointerEvent): void {
    if (this._svg === null) return;
    e.preventDefault();
    this._svg.setPointerCapture(e.pointerId);
    this._drawing = true;
    this._dragRect = this._canvas.getBoundingClientRect();
    this._pathD = '';
    this._points = [this._toCanvasPoint(e)];
    this._renderPath();
  }

  private _handlePointerMove(e: PointerEvent): void {
    if (!this._drawing) return;
    const p = this._toCanvasPoint(e);
    // Skip duplicate / near-duplicate samples — saves ~30% of the
    // path-d string growth on a slow drag and avoids the
    // `pointInPolygon2D` test repeating an identical vertex.
    const last = this._points.at(-1);
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 2) return;
    this._points.push(p);
    this._renderPath();
  }

  private _handlePointerUp(e: PointerEvent): void {
    if (!this._drawing) return;
    if (this._svg?.hasPointerCapture(e.pointerId)) {
      this._svg.releasePointerCapture(e.pointerId);
    }
    this._drawing = false;
    const committed = this._points.slice();
    // Drop trivially small loops — fewer than 3 unique points cannot
    // form a polygon, and a 4-px shape on a 1000-px canvas is almost
    // certainly an accidental click.
    if (committed.length < 3) {
      this._clearPath();
      return;
    }
    // Clear the path on screen — the next selection re-uses the SVG.
    this._clearPath();
    this._points = [];
    this._cb.onCommit(committed, this._basis);
  }

  private _abort(): void {
    this._drawing = false;
    this._points = [];
    this._clearPath();
    this._cb.onCancel?.();
  }

  // ── Helpers ─────────────────────────────────────────────────────

  /** Convert a pointer event's client position to canvas-space CSS px. */
  private _toCanvasPoint(e: PointerEvent): LassoPoint {
    // Reuse the rect captured at pointerdown; it can't change mid-drag, so
    // re-reading it per pointermove would force a synchronous reflow.
    const rect = this._dragRect ?? this._canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  /** Append the newest sample to the SVG path's `d`. Incremental (one segment
   *  per call) rather than rebuilding the whole string each move. */
  private _renderPath(): void {
    if (this._path === null || this._points.length === 0) return;
    const p = this._points[this._points.length - 1];
    this._pathD =
      this._points.length === 1 ? `M ${p.x} ${p.y}` : `${this._pathD} L ${p.x} ${p.y}`;
    // Close back to the first point once there are more than two samples — a
    // hint of the final selection shape during the drag. The `Z` is not stored
    // in `_pathD` so the growing prefix stays append-only.
    this._path.setAttribute('d', this._points.length > 2 ? `${this._pathD} Z` : this._pathD);
  }

  private _clearPath(): void {
    this._pathD = '';
    this._dragRect = null;
    if (this._path) this._path.setAttribute('d', '');
  }
}

