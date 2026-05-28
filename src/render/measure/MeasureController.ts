/**
 * MeasureController.ts
 *
 * The measurement toolkit's orchestrator. It owns the placed measurements,
 * the in-progress draft, the active measurement kind, the live-preview
 * cursor, the kind-picker toolbar, and the instruction hint; it delegates
 * all SVG drawing to `MeasureOverlay`.
 *
 * The straight-line distance tool is preserved exactly as the `distance`
 * kind so its long-standing behaviour does not regress. Browser-bound
 * (DOM): not imported in Node tests. The measurement maths it relies on is
 * the pure, unit-tested `geometry.ts` / `format.ts`.
 */

import type * as THREE from 'three/webgpu';
import { el } from '../../ui/dom';
import type { Vec3 } from '../navMath';
import type { Measurement, MeasurementKind, UnitSystem } from './types';
import { MIN_POINTS, isFull } from './types';
import {
  distance,
  polylineLength,
  polygonAreaPlanar,
  polygonAreaHorizontal,
  verticalDelta,
  slopeBetween,
  angleAtVertex,
  profileMetrics,
} from './geometry';
import {
  formatLength,
  formatArea,
  formatAngle,
  formatGrade,
  formatProfileHeadline,
} from './format';
import { MeasureOverlay } from './MeasureOverlay';
import type {
  OverlayModel,
  OverlayVertex,
  OverlayEdge,
  OverlayPolygon,
  OverlayLabel,
} from './MeasureOverlay';

/** Touch devices say "Tap" rather than "Click" in the instruction hint. */
const COARSE_POINTER =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;
const VERB = COARSE_POINTER ? 'Tap' : 'Click';
const VERB_LOWER = VERB.toLowerCase();

/** Display name per kind, for default measurement names and the picker. */
const KIND_LABEL: Record<MeasurementKind, string> = {
  distance: 'Distance',
  polyline: 'Polyline',
  area: 'Area',
  height: 'Height',
  angle: 'Angle',
  slope: 'Slope',
  profile: 'Profile',
};

/** Hover hints for the kind picker — what each tool measures and how. */
const KIND_TITLE: Record<MeasurementKind, string> = {
  distance: 'Distance — straight line between two picked points',
  polyline: 'Polyline — total length of a multi-point path',
  area: 'Area — polygon area, both true (own-plane) and horizontal',
  height: 'Height — vertical difference between two points',
  angle: 'Angle — the angle at a vertex between two arms',
  slope: 'Slope — rise, run, grade and inclination between two points',
  profile:
    'Profile — cross-section line: 3D length, horizontal distance, vertical drop, and grade',
};

/** Kind order for the picker buttons. */
const KIND_ORDER: MeasurementKind[] = [
  'distance',
  'polyline',
  'area',
  'height',
  'angle',
  'slope',
  'profile',
];

/** Hooks the controller calls back into. */
export interface MeasureCallbacks {
  /** The user dismissed the tool (the "Done" button). */
  onExit: () => void;
}

/** A compact, display-ready summary of one measurement, for the panel. */
export interface MeasurementSummary {
  id: string;
  kind: MeasurementKind;
  name: string;
  value: string;
}

export class MeasureController {
  /** The SVG overlay element — append to the stage overlay. */
  readonly overlay: SVGSVGElement;
  /** The measurement toolbar shown while measuring — append to the overlay. */
  readonly hint: HTMLElement;

  private readonly _cb: MeasureCallbacks;
  private readonly _draw = new MeasureOverlay();
  private readonly _hintEl: HTMLElement;
  private readonly _clearBtn: HTMLButtonElement;
  private readonly _unitsBtn: HTMLButtonElement;
  private readonly _kindButtons = new Map<MeasurementKind, HTMLButtonElement>();
  private _onChange: (() => void) | null = null;
  /** Called when the unit system changes — used to persist the preference. */
  private _onUnitChange: (() => void) | null = null;

  /** Re-picks a cloud point at the given NDC — injected by the Viewer. */
  private _picker: ((ndcX: number, ndcY: number) => Vec3 | null) | null = null;
  /** The handle being dragged: a measurement id and vertex index. */
  private _drag: { id: string; vi: number } | null = null;
  private _dragNdcX = 0;
  private _dragNdcY = 0;
  private _dragDirty = false;
  private readonly _onDragMove: (e: PointerEvent) => void;
  private readonly _onDragUp: () => void;

  /** Completed measurements. */
  private _measurements: Measurement[] = [];
  /** The measurement currently being placed, if any. */
  private _draft: Measurement | null = null;
  /** The active measurement kind new drafts are created as. */
  private _kind: MeasurementKind = 'distance';
  /** The live-preview point under the cursor, or null when off the cloud. */
  private _cursor: Vec3 | null = null;
  private _active = false;
  private _worldUp: Vec3 = [0, 0, 1];
  private _units: UnitSystem = 'metric';
  private readonly _counters: Record<MeasurementKind, number> = {
    distance: 0,
    polyline: 0,
    area: 0,
    height: 0,
    angle: 0,
    slope: 0,
    profile: 0,
  };

  constructor(callbacks: MeasureCallbacks) {
    this._cb = callbacks;
    this.overlay = this._draw.element;

    // ── Kind picker — one button per measurement kind ─────────────────────
    const kindRow = el('div', { className: 'olv-mkinds' });
    for (const k of KIND_ORDER) {
      const btn = el('button', {
        className: 'olv-mkind',
        text: KIND_LABEL[k],
        title: KIND_TITLE[k],
      });
      btn.addEventListener('click', () => {
        btn.blur();
        this.setKind(k);
      });
      this._kindButtons.set(k, btn);
      kindRow.append(btn);
    }

    // ── Instruction text + action buttons ─────────────────────────────────
    this._hintEl = el('span', { className: 'olv-measure-hint-text' });

    const undoBtn = el('button', {
      className: 'olv-measure-undo',
      text: 'Undo point',
      title: 'Remove the last point you placed',
    });
    undoBtn.addEventListener('click', () => {
      undoBtn.blur();
      this.undoLastPoint();
    });
    this._clearBtn = el('button', {
      className: 'olv-measure-clear olv-hidden',
      text: 'Clear all',
      title: 'Delete every measurement on the scan',
    });
    this._clearBtn.addEventListener('click', () => {
      this._clearBtn.blur();
      this.clear();
    });
    this._unitsBtn = el('button', {
      className: 'olv-units-toggle',
      text: 'Metric',
      title: 'Switch all readouts between metric and imperial units',
    });
    this._unitsBtn.addEventListener('click', () => {
      this._unitsBtn.blur();
      this.setUnitSystem(this._units === 'metric' ? 'imperial' : 'metric');
    });
    const doneBtn = el('button', {
      className: 'olv-measure-done',
      text: 'Done',
      title: 'Finish the current measurement and exit the Measure tool',
    });
    doneBtn.addEventListener('click', () => {
      doneBtn.blur();
      this.finishCurrent();
      this._cb.onExit();
    });

    this.hint = el('div', { className: 'olv-measure-bar olv-hidden' }, [
      kindRow,
      el('div', { className: 'olv-measure-hint-row' }, [
        el('span', { className: 'olv-measure-badge', text: 'Measure' }),
        this._hintEl,
      ]),
      el('div', { className: 'olv-measure-actions' }, [
        undoBtn,
        this._clearBtn,
        this._unitsBtn,
        doneBtn,
      ]),
    ]);
    this._renderKindButtons();

    // Handle dragging: a pointerdown on a vertex handle starts an edit drag.
    this._onDragMove = (e) => this._handleDragMove(e);
    this._onDragUp = () => this._endDrag();
    this._draw.element.addEventListener('pointerdown', (e) => this._handlePointerDown(e));
  }

  /** Whether measurement mode is currently on. */
  get active(): boolean {
    return this._active;
  }

  /** The active measurement kind. */
  get kind(): MeasurementKind {
    return this._kind;
  }

  /** The active unit system. */
  get unitSystem(): UnitSystem {
    return this._units;
  }

  /** A snapshot of all completed measurements. */
  getMeasurements(): Measurement[] {
    return this._measurements;
  }

  /** Replace all measurements — used when importing a session. */
  loadMeasurements(measurements: Measurement[]): void {
    this._measurements = measurements;
    this._draft = null;
    this._endDrag();
    this._updateHint();
    this._emitChange();
  }

  /** Compact per-measurement summaries for the Measurements panel. */
  getSummaries(): MeasurementSummary[] {
    return this._measurements.map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name,
      value: this._headlineText(m),
    }));
  }

  /** Register a callback fired whenever the completed-measurement list changes. */
  setOnChange(cb: () => void): void {
    this._onChange = cb;
  }

  /** Register a callback fired whenever the unit system changes. */
  setOnUnitChange(cb: () => void): void {
    this._onUnitChange = cb;
  }

  /** Inject the cloud-point picker used while dragging a vertex handle. */
  setPicker(pick: (ndcX: number, ndcY: number) => Vec3 | null): void {
    this._picker = pick;
  }

  /** Whether a vertex handle is currently being dragged. */
  get dragging(): boolean {
    return this._drag !== null;
  }

  /** Delete a measurement by id. */
  removeMeasurement(id: string): void {
    this._measurements = this._measurements.filter((m) => m.id !== id);
    this._updateHint();
    this._emitChange();
  }

  /** Rename a measurement. The overlay shows no names, so no redraw is needed. */
  renameMeasurement(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const m = this._measurements.find((x) => x.id === id);
    if (m) m.name = trimmed;
  }

  /** Enter or leave measurement mode. Completed measurements stay drawn. */
  setActive(on: boolean): void {
    this._active = on;
    this._draft = null;
    this._cursor = null;
    if (!on) this._endDrag();
    this.hint.classList.toggle('olv-hidden', !on);
    this._updateHint();
  }

  /** Choose which kind of measurement the next placement creates. */
  setKind(kind: MeasurementKind): void {
    if (kind === this._kind) return;
    this._kind = kind;
    this._draft = null; // switching kinds abandons an in-progress measurement
    this._renderKindButtons();
    this._updateHint();
  }

  /** Provide the scan's up-axis and origin (origin reserved for later phases). */
  setContext(ctx: { worldUp: Vec3; origin: Vec3 }): void {
    this._worldUp = ctx.worldUp;
  }

  /** Switch the unit system; every label re-formats on the next frame. */
  setUnitSystem(units: UnitSystem): void {
    this._units = units;
    this._unitsBtn.textContent = units === 'metric' ? 'Metric' : 'Imperial';
    this._updateHint();
    this._emitChange();
    this._onUnitChange?.();
  }

  /** Place a vertex at a picked point. `null` means a click that missed. */
  addPoint(point: Vec3 | null): void {
    if (!this._active) return;
    if (!point) {
      this._setHintText(`No point there — ${VERB_LOWER} directly on the scan`);
      return;
    }
    if (!this._draft) this._draft = this._newDraft();
    this._draft.points.push([point[0], point[1], point[2]]);
    if (isFull(this._draft)) this._commitDraft();
    this._updateHint();
  }

  /** Update the live-preview cursor point (`null` = pointer off the cloud). */
  setCursor(point: Vec3 | null): void {
    // While dragging a handle, the placement preview is suppressed.
    this._cursor = this._drag ? null : point;
  }

  /** Finish an in-progress polyline / area, committing it when it is valid. */
  finishCurrent(): void {
    if (!this._draft) return;
    if (this._draft.points.length >= MIN_POINTS[this._draft.kind]) {
      if (this._draft.kind === 'area') this._draft.closed = true;
      this._commitDraft();
    } else {
      this._draft = null;
    }
    this._updateHint();
  }

  /** Remove the most recently placed vertex of the in-progress measurement. */
  undoLastPoint(): void {
    if (!this._draft) return;
    this._draft.points.pop();
    if (this._draft.points.length === 0) this._draft = null;
    this._updateHint();
  }

  /** Remove every measurement. */
  clear(): void {
    this._measurements = [];
    this._draft = null;
    this._updateHint();
    this._emitChange();
  }

  /** Project all measurements and redraw. Called once per frame by the Viewer. */
  render(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement): void {
    this._applyDrag();
    this._draw.render(this._buildModel(), camera, canvas);
  }

  /** The current frame's geometry as a standalone SVG — used by the screenshot export. */
  overlaySVG(): string {
    return this._draw.toSVGString();
  }

  /** Free DOM references. */
  dispose(): void {
    this._endDrag();
    this._draw.dispose();
    this.hint.remove();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private _newDraft(): Measurement {
    const n = ++this._counters[this._kind];
    return {
      id: freshId(),
      kind: this._kind,
      name: `${KIND_LABEL[this._kind]} ${n}`,
      points: [],
      closed: false,
    };
  }

  private _commitDraft(): void {
    if (!this._draft) return;
    this._measurements.push(this._draft);
    this._draft = null;
    this._emitChange();
  }

  private _setHintText(text: string): void {
    this._hintEl.textContent = text;
    this._clearBtn.classList.toggle('olv-hidden', this._measurements.length === 0);
  }

  private _renderKindButtons(): void {
    for (const [k, btn] of this._kindButtons) {
      btn.classList.toggle('olv-mkind-active', k === this._kind);
    }
  }

  private _emitChange(): void {
    this._onChange?.();
  }

  /** A pointerdown on a vertex handle begins an edit drag. */
  private _handlePointerDown(e: PointerEvent): void {
    if (!this._active) return;
    const target = e.target as Element | null;
    const mid = target?.getAttribute('data-mid') ?? null;
    const viAttr = target?.getAttribute('data-vi') ?? null;
    if (mid === null || viAttr === null) return;
    e.preventDefault();
    this._drag = { id: mid, vi: Number(viAttr) };
    this._cursor = null;
    window.addEventListener('pointermove', this._onDragMove);
    window.addEventListener('pointerup', this._onDragUp);
  }

  /** Track the drag pointer; the actual re-pick is coalesced into `render`. */
  private _handleDragMove(e: PointerEvent): void {
    if (!this._drag) return;
    const rect = this._draw.element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this._dragNdcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._dragNdcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._dragDirty = true;
  }

  /** Re-pick the dragged handle's point — at most once per frame. */
  private _applyDrag(): void {
    const drag = this._drag;
    if (!drag || !this._dragDirty || !this._picker) return;
    this._dragDirty = false;
    const point = this._picker(this._dragNdcX, this._dragNdcY);
    if (!point) return;
    const m = this._measurements.find((x) => x.id === drag.id);
    if (m && drag.vi < m.points.length) {
      m.points[drag.vi] = [point[0], point[1], point[2]];
    }
  }

  /** End a handle drag, detaching the window listeners. */
  private _endDrag(): void {
    if (!this._drag) return;
    this._drag = null;
    this._dragDirty = false;
    window.removeEventListener('pointermove', this._onDragMove);
    window.removeEventListener('pointerup', this._onDragUp);
    this._emitChange();
  }

  /** The headline value string for a measurement, shown in the panel. */
  private _headlineText(m: Measurement): string {
    const p = m.points;
    switch (m.kind) {
      case 'distance':
        return p.length >= 2 ? formatLength(distance(p[0], p[1]), this._units) : '—';
      case 'polyline':
        return formatLength(polylineLength(p).total, this._units);
      case 'area':
        return p.length >= 3 ? formatArea(polygonAreaPlanar(p), this._units) : '—';
      case 'height':
        return p.length >= 2
          ? formatLength(
              Math.abs(verticalDelta(p[0], p[1], this._worldUp).vertical),
              this._units,
            )
          : '—';
      case 'angle':
        return p.length >= 3 ? formatAngle(angleAtVertex(p[0], p[1], p[2])) : '—';
      case 'slope': {
        if (p.length < 2) return '—';
        const s = slopeBetween(p[0], p[1], this._worldUp);
        return `${formatGrade(s.gradePercent)} · ${formatAngle(s.angleDeg)}`;
      }
      case 'profile': {
        if (p.length < 2) return '—';
        const pm = profileMetrics(p[0], p[1], this._worldUp);
        return formatProfileHeadline(
          pm.length3d,
          pm.verticalDrop,
          pm.gradePercent,
          this._units,
        );
      }
    }
  }

  private _updateHint(): void {
    if (this._active) this._setHintText(this._composeHint());
  }

  private _composeHint(): string {
    const d = this._draft;
    const n = d ? d.points.length : 0;
    switch (this._kind) {
      case 'distance':
        if (n === 1) return `${VERB} the second point`;
        if (this._measurements.length > 0) return `${VERB} two more points to measure again`;
        return `${VERB} the first point on the scan`;
      case 'polyline': {
        if (!d || d.points.length < 2) return `${VERB} points along the path`;
        const total = formatLength(polylineLength(d.points).total, this._units);
        return `${total} · ${VERB} more, or Done to finish`;
      }
      case 'area': {
        if (!d || d.points.length < 3) return `${VERB} polygon vertices — three or more`;
        const area = formatArea(polygonAreaPlanar(d.points), this._units);
        return `${area} · ${VERB} more, or Done to close`;
      }
      case 'height':
      case 'slope':
      case 'profile':
        return n === 1 ? `${VERB} the second point` : `${VERB} the first point`;
      case 'angle':
        if (n === 1) return `${VERB} the angle vertex`;
        if (n === 2) return `${VERB} the third point`;
        return `${VERB} the first point`;
    }
  }

  private _buildModel(): OverlayModel {
    const vertices: OverlayVertex[] = [];
    const edges: OverlayEdge[] = [];
    const polygons: OverlayPolygon[] = [];
    const labels: OverlayLabel[] = [];
    for (const m of this._measurements) {
      this._appendMeasurement(m, vertices, edges, polygons, labels);
    }
    if (this._draft) this._appendDraft(this._draft, vertices, edges, polygons, labels);
    return { polygons, edges, vertices, labels };
  }

  /** Add a committed measurement's geometry to the draw model. */
  private _appendMeasurement(
    m: Measurement,
    V: OverlayVertex[],
    E: OverlayEdge[],
    P: OverlayPolygon[],
    L: OverlayLabel[],
  ): void {
    const pts = m.points;
    pts.forEach((p, i) => {
      V.push({
        p,
        role: 'normal',
        handle: this._active ? { mid: m.id, vi: i } : undefined,
      });
    });

    if (m.kind === 'distance' && pts.length >= 2) {
      E.push({ a: pts[0], b: pts[1], style: 'solid' });
      L.push({
        anchor: midpoint(pts[0], pts[1]),
        text: formatLength(distance(pts[0], pts[1]), this._units),
        primary: true,
      });
      return;
    }
    if (m.kind === 'polyline' && pts.length >= 2) {
      const r = polylineLength(pts);
      for (let i = 1; i < pts.length; i++) {
        E.push({ a: pts[i - 1], b: pts[i], style: 'solid' });
        L.push({
          anchor: midpoint(pts[i - 1], pts[i]),
          text: formatLength(r.segments[i - 1], this._units),
          primary: false,
        });
      }
      L.push({
        anchor: pts[pts.length - 1],
        text: formatLength(r.total, this._units),
        primary: true,
      });
      return;
    }
    if (m.kind === 'area' && pts.length >= 3) {
      for (let i = 0; i < pts.length; i++) {
        E.push({ a: pts[i], b: pts[(i + 1) % pts.length], style: 'solid' });
      }
      P.push({ points: pts });
      const planar = formatArea(polygonAreaPlanar(pts), this._units);
      const horiz = formatArea(polygonAreaHorizontal(pts, this._worldUp), this._units);
      L.push({ anchor: centroid(pts), text: `${planar} · map ${horiz}`, primary: true });
      return;
    }
    if (m.kind === 'height' && pts.length >= 2) {
      const [a, b] = pts;
      const elbow = elbowPoint(a, b, this._worldUp);
      const d = verticalDelta(a, b, this._worldUp);
      E.push({ a, b: elbow, style: 'solid' });
      E.push({ a: elbow, b, style: 'solid' });
      L.push({
        anchor: midpoint(elbow, b),
        text: formatLength(Math.abs(d.vertical), this._units),
        primary: true,
      });
      L.push({
        anchor: midpoint(a, elbow),
        text: formatLength(d.horizontal, this._units),
        primary: false,
      });
      return;
    }
    if (m.kind === 'slope' && pts.length >= 2) {
      const [a, b] = pts;
      const elbow = elbowPoint(a, b, this._worldUp);
      const s = slopeBetween(a, b, this._worldUp);
      E.push({ a, b, style: 'solid' });
      E.push({ a, b: elbow, style: 'preview' });
      E.push({ a: elbow, b, style: 'preview' });
      L.push({
        anchor: midpoint(a, b),
        text: `${formatGrade(s.gradePercent)} · ${formatAngle(s.angleDeg)}`,
        primary: true,
      });
      L.push({
        anchor: midpoint(elbow, b),
        text: formatLength(Math.abs(s.rise), this._units),
        primary: false,
      });
      L.push({
        anchor: midpoint(a, elbow),
        text: formatLength(s.run, this._units),
        primary: false,
      });
      return;
    }
    if (m.kind === 'angle' && pts.length >= 3) {
      const [a, vertex, c] = pts;
      E.push({ a, b: vertex, style: 'solid' });
      E.push({ a: vertex, b: c, style: 'solid' });
      L.push({
        anchor: vertex,
        text: formatAngle(angleAtVertex(a, vertex, c)),
        primary: true,
      });
    }
    if (m.kind === 'profile' && pts.length >= 2) {
      // Profile draws the 3D segment as the solid headline and an L-bent
      // preview that shows the horizontal run and vertical drop separately
      // — the same idiom the slope tool uses, so users transferring between
      // the two see consistent geometry. The headline label carries the
      // combined readout (length · Δh · grade).
      const [a, b] = pts;
      const elbow = elbowPoint(a, b, this._worldUp);
      const pm = profileMetrics(a, b, this._worldUp);
      E.push({ a, b, style: 'solid' });
      E.push({ a, b: elbow, style: 'preview' });
      E.push({ a: elbow, b, style: 'preview' });
      L.push({
        anchor: midpoint(a, b),
        text: formatProfileHeadline(
          pm.length3d,
          pm.verticalDrop,
          pm.gradePercent,
          this._units,
        ),
        primary: true,
      });
      L.push({
        anchor: midpoint(elbow, b),
        text: formatLength(Math.abs(pm.verticalDrop), this._units),
        primary: false,
      });
      L.push({
        anchor: midpoint(a, elbow),
        text: formatLength(pm.lengthHorizontal, this._units),
        primary: false,
      });
    }
  }

  /** Add the in-progress draft, including its live preview toward the cursor. */
  private _appendDraft(
    d: Measurement,
    V: OverlayVertex[],
    E: OverlayEdge[],
    P: OverlayPolygon[],
    L: OverlayLabel[],
  ): void {
    const pts = d.points;
    pts.forEach((p, i) => {
      V.push({ p, role: i === pts.length - 1 ? 'pending' : 'normal' });
    });
    for (let i = 1; i < pts.length; i++) {
      E.push({ a: pts[i - 1], b: pts[i], style: 'solid' });
    }

    const cur = this._cursor;
    if (!cur || pts.length === 0) return;
    const last = pts[pts.length - 1];

    if (d.kind === 'distance') {
      E.push({ a: last, b: cur, style: 'preview' });
      L.push({
        anchor: midpoint(last, cur),
        text: formatLength(distance(last, cur), this._units),
        primary: true,
      });
      return;
    }
    if (d.kind === 'polyline') {
      E.push({ a: last, b: cur, style: 'preview' });
      L.push({
        anchor: cur,
        text: formatLength(polylineLength([...pts, cur]).total, this._units),
        primary: true,
      });
      return;
    }
    if (d.kind === 'area') {
      E.push({ a: last, b: cur, style: 'preview' });
      const ring = [...pts, cur];
      if (ring.length >= 3) {
        E.push({ a: cur, b: pts[0], style: 'preview' });
        P.push({ points: ring });
        L.push({
          anchor: centroid(ring),
          text: formatArea(polygonAreaPlanar(ring), this._units),
          primary: true,
        });
      }
      return;
    }
    if (d.kind === 'height') {
      const elbow = elbowPoint(pts[0], cur, this._worldUp);
      E.push({ a: pts[0], b: elbow, style: 'preview' });
      E.push({ a: elbow, b: cur, style: 'preview' });
      L.push({
        anchor: midpoint(elbow, cur),
        text: formatLength(
          Math.abs(verticalDelta(pts[0], cur, this._worldUp).vertical),
          this._units,
        ),
        primary: true,
      });
      return;
    }
    if (d.kind === 'slope') {
      const elbow = elbowPoint(pts[0], cur, this._worldUp);
      const s = slopeBetween(pts[0], cur, this._worldUp);
      E.push({ a: pts[0], b: cur, style: 'preview' });
      E.push({ a: pts[0], b: elbow, style: 'preview' });
      E.push({ a: elbow, b: cur, style: 'preview' });
      L.push({
        anchor: midpoint(pts[0], cur),
        text: `${formatGrade(s.gradePercent)} · ${formatAngle(s.angleDeg)}`,
        primary: true,
      });
      return;
    }
    if (d.kind === 'angle') {
      E.push({ a: last, b: cur, style: 'preview' });
      if (pts.length === 2) {
        L.push({
          anchor: pts[1],
          text: formatAngle(angleAtVertex(pts[0], pts[1], cur)),
          primary: true,
        });
      }
    }
    if (d.kind === 'profile') {
      // Same preview idiom as `slope` — solid 3D segment with the L-bent
      // run/drop ghost — but the live label carries the combined profile
      // readout (length · Δh · grade).
      const elbow = elbowPoint(pts[0], cur, this._worldUp);
      const pm = profileMetrics(pts[0], cur, this._worldUp);
      E.push({ a: pts[0], b: cur, style: 'preview' });
      E.push({ a: pts[0], b: elbow, style: 'preview' });
      E.push({ a: elbow, b: cur, style: 'preview' });
      L.push({
        anchor: midpoint(pts[0], cur),
        text: formatProfileHeadline(
          pm.length3d,
          pm.verticalDrop,
          pm.gradePercent,
          this._units,
        ),
        primary: true,
      });
    }
  }
}

/** Midpoint of two points. */
function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/**
 * The right-angle elbow of a vertical pair: the point at `a`'s height and
 * `b`'s horizontal position, so a height / slope measurement can draw its
 * rise and run as separate legs. `up` must be a unit vector.
 */
function elbowPoint(a: Vec3, b: Vec3, up: Vec3): Vec3 {
  const rise =
    (b[0] - a[0]) * up[0] + (b[1] - a[1]) * up[1] + (b[2] - a[2]) * up[2];
  return [b[0] - rise * up[0], b[1] - rise * up[1], b[2] - rise * up[2]];
}

/** Average position of a set of points. */
function centroid(points: Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = points.length || 1;
  return [x / n, y / n, z / n];
}

/** A reasonably unique id — `crypto.randomUUID` when available, else a fallback. */
function freshId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `m_${Math.random().toString(36).slice(2, 11)}`;
}
