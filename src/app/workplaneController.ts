/**
 * workplaneController.ts
 *
 * The reference plane's behaviour: its settings, the picks that place it, the
 * adaptive spacing, and when GPU resources exist. The drawing is
 * `WorkplaneOverlay`; the decisions are the pure modules under
 * `render/workplane/`; this file joins them to the live viewer.
 *
 * VISUAL ONLY. The plane adds scene objects through the viewer's derived-layer
 * host and reads the camera and the scene's frame. It writes nothing back:
 * not to the scan, not to measurements, classification, terrain, exports or
 * digests. Picks read the scan through the viewer's ordinary point pick.
 *
 * FRAME. Settings are kept in source coordinates (what the readouts show).
 * Scene coordinates are source minus the scene datum, the origin every open
 * layer shares. When the open layers share no datum there is no single source
 * frame to place the plane in, so it is not drawn and the panel says why; a
 * saved plane is never reinterpreted in another frame.
 *
 * BOUNDS. Every value is range-checked (`WORKPLANE_MAX_ABS`), a fixed spacing
 * is raised to at least `FIXED_SPACING_FLOOR` of the scan size, and a patch
 * whose lattice indices would not be exact integers is not drawn
 * (`patchFor` returns null). Together these keep a typed value or a hostile
 * session file from freezing the tab.
 *
 * GPU LIFETIME. Buffers exist only while the plane is on and drawable. Turning
 * it off, resetting it for a closed scan and `dispose()` all free them; a
 * restored WebGL context re-uploads the CPU arrays the geometry still holds.
 */

import { DEFAULT_FOV } from '../render/renderBootstrapPolicy';
import type { SceneOverlayHost } from '../render/sceneLineOverlay';
import type { SpatialContext } from '../geo/SpatialContext';
import {
  WORKPLANE_DEFAULTS,
  WORKPLANE_MAX_ABS,
  parseWorkplaneSettings,
  type WorkplaneOrientationSetting,
  type WorkplaneSettings,
  type WorkplaneTriple,
} from '../model/workplaneSettings';
import {
  elevationOf,
  horizontalIndices,
  placeOnPlane,
  planeFromThreePoints,
  principalPlane,
  upIndex,
  type Vec3,
  type WorkplaneBasis,
  type WorkplaneUpAxis,
} from '../render/workplane/workplanePlane';
import { chooseAutoSpacing, fixedSpacing, MINOR_MIN_PX, type GridSpacing } from '../render/workplane/workplaneSpacing';
import {
  buildWorkplaneGeometry,
  patchFor,
  writeFade,
  planeCoordsOf,
  type WorkplaneGeometry,
} from '../render/workplane/workplaneGeometry';
import type { WorkplaneKind } from '../render/workplane/WorkplaneOverlay';
import { sampleWorkplaneView } from '../render/workplane/workplaneView';
import { workplaneFigureNote, workplaneReadout, workplaneUnits, type WorkplaneUnits } from '../render/workplane/workplaneReadout';

/** The viewer surface the plane uses. `Viewer` satisfies it structurally. */
export interface WorkplaneViewer {
  getCameraState(): {
    position: readonly [number, number, number];
    target: readonly [number, number, number];
    fov?: number;
  };
  readonly orthographic: boolean;
  derivedLayerHost(): SceneOverlayHost;
  onDrawnFrame(listener: () => void): () => void;
  /** The scan point under a screen position, in scene coordinates. */
  pickPoint(ndcX: number, ndcY: number): { x: number; y: number; z: number } | null;
  /** The visible scan's box in scene coordinates, `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  mergedVisibleBounds(): readonly number[] | null;
  readonly measure: { readonly worldUp: readonly number[]; readonly datumResolved: boolean };
  clouds(): readonly string[];
  readonly hasStreamingCloud: boolean;
  /** A picking tool (measure, inspect, annotate) owns canvas clicks while true. */
  readonly toolActive?: boolean;
}

/** What the overlay must do. `WorkplaneOverlay` satisfies it. */
export interface WorkplaneDrawing {
  update(geom: WorkplaneGeometry): void;
  /** The fade buffer of a line set, written in place, then committed. */
  fadeBuffer(kind: WorkplaneKind): Float32Array | null;
  commitFade(kind: WorkplaneKind): void;
  setBackdrop(backdrop: 'dark' | 'light'): void;
  setVisible(visible: boolean): void;
  dispose(): void;
  readonly liveResources: number;
}

/** The canvas the picks are read from. */
export interface WorkplaneCanvas {
  readonly clientWidth: number;
  readonly clientHeight: number;
  addEventListener(type: 'pointerdown' | 'pointerup', listener: (e: PointerEvent) => void): void;
  removeEventListener(type: 'pointerdown' | 'pointerup', listener: (e: PointerEvent) => void): void;
}

export interface WorkplaneControllerDeps {
  readonly viewer: () => WorkplaneViewer | null;
  readonly canvas: WorkplaneCanvas;
  readonly context: () => SpatialContext | null;
  /** Source coordinate of the scene datum (scene = source - datum). */
  readonly sceneOrigin: () => readonly [number, number, number];
  readonly makeDrawing: (host: SceneOverlayHost) => WorkplaneDrawing;
  /** Whether the scene behind the plane is light. */
  readonly lightBackdrop: () => boolean;
  /** Called after every change the panel shows. */
  readonly onChange: (view: WorkplaneView) => void;
}

/** Everything the panel shows. */
export interface WorkplaneView {
  readonly settings: WorkplaneSettings;
  /** The origin in use: the set one, or the scan centre rounded to the grid. Null before a scan and grid exist. */
  readonly originH: readonly [number, number] | null;
  /** The elevation of the origin in use (on a three-point plane, the plane's). */
  readonly elevation: number | null;
  readonly units: WorkplaneUnits;
  readonly axisNames: readonly [string, string];
  readonly readout: readonly string[];
  /** A pick prompt, a refusal, or null. */
  readonly status: string | null;
  readonly picking: 'origin' | 'three-point' | null;
  /** Whether lines are on screen now. */
  readonly drawn: boolean;
  /** GPU geometries and materials allocated now. */
  readonly liveResources: number;
}

export interface WorkplaneController {
  view(): WorkplaneView;
  setEnabled(on: boolean): void;
  setOrientation(o: Exclude<WorkplaneOrientationSetting, 'three-point'>): void;
  setOriginH(east: number, north: number): void;
  setElevation(value: number): void;
  setFixedSpacing(major: number | null): void;
  useScanMinimum(): void;
  /** Go back to the scan centre, rounded to the grid, for the horizontal origin. */
  useScanCentre(): void;
  beginPick(kind: 'origin' | 'three-point'): void;
  cancelPick(): void;
  restore(settings: WorkplaneSettings): void;
  /** The scan the plane was placed for has closed: free the GPU and forget it. */
  reset(): void;
  /** Run `fn` with the plane hidden (an image export that must not carry it). */
  without<T>(fn: () => Promise<T>): Promise<T>;
  /** The provenance note for a snapshot, or null when nothing is drawn. */
  figureNote(): string | null;
  /** Re-read the camera and redraw if the grid must change. */
  refresh(): void;
  /** The frame or its units changed (a CRS resolve or override): rebuild and re-read. */
  reframe(): void;
  dispose(): void;
}

/** A fixed spacing is raised to at least this share of the scan's largest dimension. */
export const FIXED_SPACING_FLOOR = 1e-6;

/** A pick within this many CSS px of where the press began is a click, not a drag. */
const CLICK_SLOP_PX = 5;

const PICK_PROMPTS = [
  'Click the first point on the scan.',
  'Click the second point.',
  'Click the third point, away from the line through the first two.',
] as const;

export function createWorkplaneController(deps: WorkplaneControllerDeps): WorkplaneController {
  let settings: WorkplaneSettings = WORKPLANE_DEFAULTS;
  let drawing: WorkplaneDrawing | null = null;
  let unsubscribeFrame: (() => void) | null = null;
  let previousMajor: number | null = null;
  let lastSpacing: (GridSpacing & { showMinor: boolean }) | null = null;
  let lastGeom: WorkplaneGeometry | null = null;
  let lastPlane: WorkplaneBasis | null = null;
  // Numeric keys, compared in place, so an idle or orbiting frame allocates no strings.
  const lastKeyNums: number[] = [];
  const lastPoseNums: number[] = [];
  const sameAs = (store: number[], next: readonly number[]): boolean => {
    if (store.length !== next.length) return false;
    for (let i = 0; i < next.length; i++) if (store[i] !== next[i]) return false;
    return true;
  };
  const keep = (store: number[], next: readonly number[]): void => {
    store.length = next.length;
    for (let i = 0; i < next.length; i++) store[i] = next[i];
  };
  // The scan box projected on the plane, kept until the box or the plane moves.
  const boxPlaneCache = { inputs: [] as number[], value: [0, 0, 0, 0] as [number, number, number, number] };
  let drawn = false;
  let hideDepth = 0;
  let floored = false;
  let blocked: string | null = null;
  let status: string | null = null;
  let picking: 'origin' | 'three-point' | null = null;
  let picks: Vec3[] = [];
  let press: { x: number; y: number } | null = null;
  let disposed = false;

  const axis = (): WorkplaneUpAxis => {
    const up = deps.viewer()?.measure.worldUp;
    return up && up[1] === 1 && up[2] !== 1 ? 'y' : 'z';
  };
  const axisNames = (): readonly [string, string] => (axis() === 'z' ? ['X', 'Y'] : ['X', 'Z']);
  const datumKnown = (): boolean => deps.viewer()?.measure.datumResolved ?? false;
  const datum = (): Vec3 => (datumKnown() ? deps.sceneOrigin() : [0, 0, 0]);
  const hasScan = (): boolean => {
    const v = deps.viewer();
    return !!v && (v.clouds().length > 0 || v.hasStreamingCloud);
  };

  const inRange = (...v: number[]): boolean => v.every((x) => Number.isFinite(x) && Math.abs(x) <= WORKPLANE_MAX_ABS);

  /** The visible scan's box in source coordinates, or null. Every visible layer counts. */
  const sourceBox = (): { min: Vec3; max: Vec3 } | null => {
    const b = deps.viewer()?.mergedVisibleBounds();
    if (!b || b.length < 6 || !b.every(Number.isFinite)) return null;
    const d = datum();
    return { min: [b[0] + d[0], b[1] + d[1], b[2] + d[2]], max: [b[3] + d[0], b[4] + d[1], b[5] + d[2]] };
  };

  /**
   * The horizontal origin in use: the one the user set, or the scan's
   * horizontal centre rounded to `major` (unrounded when no grid exists yet).
   * Rounding to the major spacing puts the auto origin on the absolute
   * lattice, so the lines do not move when the origin is re-derived.
   */
  const effectiveOriginH = (s: WorkplaneSettings, major: number | null): readonly [number, number] | null => {
    if (s.originH) return s.originH;
    const box = sourceBox();
    if (!box) return null;
    const [a, b] = horizontalIndices(axis());
    const round = (v: number): number => (major ? Math.round(v / major) * major : v);
    return [round((box.min[a] + box.max[a]) / 2), round((box.min[b] + box.max[b]) / 2)];
  };

  /** The origin as a source point. */
  const originPoint = (s: WorkplaneSettings, elevation: number, major: number | null): Vec3 => {
    const out = [0, 0, 0];
    const [a, b] = horizontalIndices(axis());
    const h = effectiveOriginH(s, major) ?? [0, 0];
    out[a] = h[0];
    out[b] = h[1];
    out[upIndex(axis())] = elevation;
    return [out[0], out[1], out[2]];
  };

  /** The plane to draw, or null when the settings do not place one yet. */
  const planeOf = (s: WorkplaneSettings, major: number | null): { basis: WorkplaneBasis; dipDeg: number | null } | null => {
    if (s.orientation === 'three-point') {
      if (!s.points) return null;
      const r = planeFromThreePoints(s.points[0], s.points[1], s.points[2], axis());
      if (!r.ok) {
        blocked = `The three saved points are in a line, or nearly, so the plane is not drawn. Pick three points again.`;
        return null;
      }
      const origin = placeOnPlane(originPoint(s, s.elevation ?? elevationOf(s.points[0], axis()), major), r.basis, axis());
      return { basis: { ...r.basis, origin }, dipDeg: r.dipDeg };
    }
    if (s.elevation === null) return null;
    return { basis: principalPlane(s.orientation, originPoint(s, s.elevation, major), axis()), dipDeg: null };
  };

  const buildView = (): WorkplaneView => {
    const units = workplaneUnits(deps.context());
    const major = lastSpacing?.major ?? null;
    const plane = planeOf(settings, major);
    const originH = effectiveOriginH(settings, major);
    const elevation =
      settings.orientation === 'three-point' && plane ? elevationOf(plane.basis.origin, axis()) : settings.elevation;
    const readout = workplaneReadout({
      orientation: settings.orientation,
      dipDeg: plane?.dipDeg ?? null,
      axisNames: axisNames(),
      originH: settings.originH ?? (major !== null ? originH : null),
      originAuto: settings.originH === null,
      elevation,
      floored,
      elevationSource: settings.elevationSource,
      spacing: plane && lastSpacing ? { ...lastSpacing, fixed: settings.fixedSpacing !== null } : null,
      units,
      datumKnown: datumKnown(),
    });
    return {
      settings,
      originH: settings.originH ?? (major !== null ? originH : null),
      elevation,
      units,
      axisNames: axisNames(),
      readout,
      status: blocked ?? status,
      picking,
      drawn,
      liveResources: drawing?.liveResources ?? 0,
    };
  };

  const emit = (): void => deps.onChange(buildView());

  const releaseGpu = (): void => {
    drawing?.dispose();
    drawing = null;
    drawn = false;
    lastKeyNums.length = 0;
    lastGeom = null;
    lastPoseNums.length = 0;
  };

  /** Write the per-vertex fade for the current camera into every line set's buffer. */
  const applyFade = (cam: { position: Vec3; target: Vec3; fov?: number }, orthographic: boolean): void => {
    if (!drawing || !lastGeom || !lastPlane) return;
    const dx = cam.target[0] - cam.position[0];
    const dy = cam.target[1] - cam.position[1];
    const dz = cam.target[2] - cam.position[2];
    const orbit = Math.hypot(dx, dy, dz) || 1e-12;
    const fadeCam = {
      position: cam.position,
      forward: [dx / orbit, dy / orbit, dz / orbit] as Vec3,
      orthographic,
      fovDeg: cam.fov ?? DEFAULT_FOV,
      orbitDistance: orbit,
      canvasCssHeight: deps.canvas.clientHeight || 1,
    };
    for (const kind of ['minor', 'major', 'axes'] as const) {
      const out = drawing.fadeBuffer(kind);
      if (!out || out.length === 0) continue;
      writeFade(lastGeom[kind], lastGeom, lastPlane, fadeCam, out);
      drawing.commitFade(kind);
    }
  };

  /** Stop drawing and say why. */
  const block = (why: string, previous: string | null): void => {
    blocked = why;
    if (drawing) releaseGpu();
    lastSpacing = null;
    if (previous !== why) emit();
  };

  /** Recompute spacing, patch and fade from the camera; rebuild only when the lines change. */
  const refresh = (): void => {
    if (disposed) return;
    const viewer = deps.viewer();
    const wasBlocked = blocked;
    blocked = null;
    if (settings.enabled && viewer && hasScan() && !datumKnown()) {
      block('The open layers do not share a datum, so the plane has no single frame to sit in and is not drawn. Close the other layers to draw it.', wasBlocked);
      return;
    }
    const provisional = settings.enabled && viewer && hasScan() ? planeOf(settings, null) : null;
    const box = sourceBox();
    if (!provisional || !viewer || !box) {
      if (blocked) {
        block(blocked, wasBlocked);
        return;
      }
      if (drawing) releaseGpu();
      lastSpacing = null;
      if (wasBlocked) emit();
      return;
    }
    const scanSize = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 1e-9);
    const cam = viewer.getCameraState();
    const sceneOrigin = datum();
    const h = deps.canvas.clientHeight || 1;
    const camIn = { position: cam.position, target: cam.target, fovDeg: cam.fov ?? DEFAULT_FOV, orthographic: viewer.orthographic };
    const first = sampleWorkplaneView(camIn, provisional.basis, sceneOrigin, h);
    const floor = FIXED_SPACING_FLOOR * scanSize;
    floored = settings.fixedSpacing !== null && settings.fixedSpacing < floor;
    const spacing =
      settings.fixedSpacing !== null
        ? fixedSpacing(Math.max(settings.fixedSpacing, floor))
        : chooseAutoSpacing(first.pxPerUnit, previousMajor) ?? (previousMajor ? fixedSpacing(previousMajor) : null);
    if (!spacing) return;
    if (settings.fixedSpacing === null) previousMajor = spacing.major;
    // The final plane: the auto origin rounded to the chosen major spacing.
    const plane = planeOf(settings, spacing.major) ?? provisional;
    const b = plane.basis;
    const sample = sampleWorkplaneView(camIn, b, sceneOrigin, h);
    // Minor lines only when they stand apart on screen and the view does not
    // graze the plane (closer than about 17 degrees to it).
    const fx = cam.target[0] - cam.position[0];
    const fy = cam.target[1] - cam.position[1];
    const fz = cam.target[2] - cam.position[2];
    const facing = Math.abs(fx * b.normal[0] + fy * b.normal[1] + fz * b.normal[2]) / (Math.hypot(fx, fy, fz) || 1);
    const showMinor = spacing.minor * sample.pxPerUnit >= MINOR_MIN_PX && (viewer.orthographic || facing >= 0.3);
    // The scan's box on the plane, and its largest dimension.
    const boxInputs = [...box.min, ...box.max, ...b.origin, ...b.u, ...b.v];
    if (!sameAs(boxPlaneCache.inputs, boxInputs)) {
      keep(boxPlaneCache.inputs, boxInputs);
      const v = boxPlaneCache.value;
      v[0] = v[2] = Infinity;
      v[1] = v[3] = -Infinity;
      for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
        const [cs, ct] = planeCoordsOf([x, y, z], b);
        v[0] = Math.min(v[0], cs);
        v[1] = Math.max(v[1], cs);
        v[2] = Math.min(v[2], ct);
        v[3] = Math.max(v[3], ct);
      }
    }
    const boxPlane = boxPlaneCache.value;
    const patch = patchFor(boxPlane, scanSize, sample.focus, spacing.major);
    if (!patch) {
      block('The origin is too far from the scan for this spacing, so the plane is not drawn. Use the scan centre or a coarser spacing.', wasBlocked);
      return;
    }
    const key = [spacing.major, spacing.minor, showMinor ? 1 : 0, patch.iMin, patch.iMax, patch.jMin, patch.jMax, ...b.origin, ...b.normal, ...b.u, ...sceneOrigin];
    lastSpacing = { ...spacing, showMinor };
    if (wasBlocked) emit();
    drawing ??= deps.makeDrawing(viewer.derivedLayerHost());
    drawing.setBackdrop(deps.lightBackdrop() ? 'light' : 'dark');
    const pose = [...cam.position, ...cam.target, cam.fov ?? DEFAULT_FOV, viewer.orthographic ? 1 : 0, h];
    if (sameAs(lastKeyNums, key)) {
      if (!sameAs(lastPoseNums, pose)) {
        keep(lastPoseNums, pose);
        applyFade(cam, viewer.orthographic);
      }
      return;
    }
    keep(lastKeyNums, key);
    keep(lastPoseNums, pose);
    lastPlane = b;
    lastGeom = buildWorkplaneGeometry({ plane: b, patch, major: spacing.major, minor: spacing.minor, showMinor, sceneOrigin });
    drawing.update(lastGeom);
    applyFade(cam, viewer.orthographic);
    drawing.setVisible(hideDepth === 0);
    drawn = true;
    // The spacing and origin readouts follow the drawn grid.
    emit();
  };

  const subscribeFrames = (): void => {
    if (unsubscribeFrame || !settings.enabled) return;
    const viewer = deps.viewer();
    if (viewer) unsubscribeFrame = viewer.onDrawnFrame(refresh);
  };
  const unsubscribeFrames = (): void => {
    unsubscribeFrame?.();
    unsubscribeFrame = null;
  };

  const apply = (next: WorkplaneSettings, message: string | null = null): void => {
    const planeChanged = next.orientation !== settings.orientation || next.fixedSpacing !== settings.fixedSpacing;
    settings = next;
    status = message;
    if (planeChanged) previousMajor = null;
    if (settings.enabled) subscribeFrames();
    else {
      unsubscribeFrames();
      releaseGpu();
    }
    lastKeyNums.length = 0;
    refresh();
    emit();
  };

  // ── picking ──────────────────────────────────────────────────────────────
  const onDown = (e: PointerEvent): void => {
    if (e.button === 0) press = { x: e.offsetX, y: e.offsetY };
  };
  const onUp = (e: PointerEvent): void => {
    const start = press;
    press = null;
    if (!picking || e.button !== 0 || !start) return;
    if (Math.hypot(e.offsetX - start.x, e.offsetY - start.y) > CLICK_SLOP_PX) return; // an orbit drag
    // A measure, inspect or annotate tool turned on mid-pick owns this click.
    if (deps.viewer()?.toolActive) {
      stopPicking();
      status = 'Picking stopped: another tool is taking clicks on the scan.';
      emit();
      return;
    }
    const w = deps.canvas.clientWidth;
    const h = deps.canvas.clientHeight;
    if (!w || !h) return;
    const hit = deps.viewer()?.pickPoint((e.offsetX / w) * 2 - 1, -(e.offsetY / h) * 2 + 1);
    if (!hit) {
      status = 'No scan point under the cursor. Click on the points.';
      emit();
      return;
    }
    const d = datum();
    acceptPick([hit.x + d[0], hit.y + d[1], hit.z + d[2]]);
  };

  const stopPicking = (): void => {
    if (!picking) return;
    picking = null;
    picks = [];
    deps.canvas.removeEventListener('pointerdown', onDown);
    deps.canvas.removeEventListener('pointerup', onUp);
  };

  /** Take one picked point, in source coordinates. */
  const acceptPick = (p: Vec3): void => {
    const [a, b] = horizontalIndices(axis());
    if (picking === 'origin') {
      stopPicking();
      if (!inRange(...p)) {
        status = 'The picked point is out of range.';
        emit();
        return;
      }
      apply({ ...settings, originH: [p[a], p[b]], elevation: elevationOf(p, axis()), elevationSource: 'picked' }, 'Origin and elevation set from the picked point.');
      return;
    }
    if (!inRange(...p)) {
      status = 'The picked point is out of range.';
      emit();
      return;
    }
    picks.push(p);
    if (picks.length < 3) {
      status = PICK_PROMPTS[picks.length];
      emit();
      return;
    }
    const [p1, p2, p3] = picks;
    const r = planeFromThreePoints(p1, p2, p3, axis());
    stopPicking();
    if (!r.ok) {
      status = `${r.reason} The plane was not changed.`;
      emit();
      return;
    }
    const pts = [p1, p2, p3].map((q) => [q[0], q[1], q[2]] as WorkplaneTriple) as [WorkplaneTriple, WorkplaneTriple, WorkplaneTriple];
    apply(
      { ...settings, orientation: 'three-point', points: pts, originH: [p1[a], p1[b]], elevation: elevationOf(p1, axis()), elevationSource: 'plane' },
      'Plane set through the three picked points. It passes through them exactly and is not fitted to the scan.',
    );
  };

  return {
    view: buildView,
    setEnabled(on) {
      if (on === settings.enabled) return;
      if (!on) stopPicking();
      apply({ ...settings, enabled: on }, on && settings.elevation === null && settings.orientation !== 'three-point'
        ? 'Set an elevation to place the plane: type it, use a picked point, or use the scan minimum.'
        : null);
    },
    setOrientation(o) {
      apply({ ...settings, orientation: o, points: null, elevationSource: settings.orientation === 'three-point' && settings.elevation !== null ? 'typed' : settings.elevationSource });
    },
    useScanCentre() {
      apply({ ...settings, originH: null }, 'Origin set to the scan centre, rounded to the grid.');
    },
    setOriginH(east, north) {
      if (!inRange(east, north)) {
        status = `The origin needs two numbers between -${WORKPLANE_MAX_ABS.toExponential(0)} and ${WORKPLANE_MAX_ABS.toExponential(0)}.`;
        emit();
        return;
      }
      apply({ ...settings, originH: [east, north], ...(settings.orientation === 'three-point' ? { elevation: null } : {}) });
    },
    setElevation(value) {
      if (!inRange(value)) {
        status = `The elevation needs a number between -${WORKPLANE_MAX_ABS.toExponential(0)} and ${WORKPLANE_MAX_ABS.toExponential(0)}.`;
        emit();
        return;
      }
      apply({ ...settings, elevation: value, elevationSource: 'typed' });
    },
    setFixedSpacing(major) {
      if (major !== null && !(Number.isFinite(major) && major > 0 && major <= WORKPLANE_MAX_ABS)) {
        status = 'A fixed spacing needs a number above zero.';
        emit();
        return;
      }
      apply({ ...settings, fixedSpacing: major });
    },
    useScanMinimum() {
      // The lowest point over every visible layer, in the same source frame the
      // plane is placed in. With no shared datum there is no such frame.
      const box = datumKnown() ? sourceBox() : null;
      if (!box) {
        status = datumKnown() ? 'No scan is open to take a minimum from.' : 'The open layers do not share a datum, so there is no single scan minimum.';
        emit();
        return;
      }
      const min = box.min[upIndex(axis())];
      if (!inRange(min)) {
        status = 'The scan minimum is out of range for the plane.';
        emit();
        return;
      }
      apply({ ...settings, elevation: min, elevationSource: 'scan-minimum' }, 'Elevation set to the scan minimum.');
    },
    beginPick(kind) {
      if (!hasScan()) {
        status = 'Open a scan first, then pick on its points.';
        emit();
        return;
      }
      if (!datumKnown()) {
        status = 'The open layers do not share a datum, so a picked point has no single frame. Close the other layers to pick.';
        emit();
        return;
      }
      if (deps.viewer()?.toolActive) {
        status = 'Another tool is taking clicks on the scan. Leave it (Esc), then pick.';
        emit();
        return;
      }
      stopPicking();
      picking = kind;
      picks = [];
      deps.canvas.addEventListener('pointerdown', onDown);
      deps.canvas.addEventListener('pointerup', onUp);
      status = kind === 'origin' ? 'Click a point on the scan for the origin and elevation.' : PICK_PROMPTS[0];
      emit();
    },
    cancelPick() {
      if (!picking) return;
      stopPicking();
      status = 'Picking cancelled.';
      emit();
    },
    restore(next) {
      stopPicking();
      // Re-checked here as well as in the session parser, so no caller can hand
      // the lattice an out-of-range value.
      apply(parseWorkplaneSettings(next) ?? WORKPLANE_DEFAULTS);
    },
    reset() {
      stopPicking();
      unsubscribeFrames();
      releaseGpu();
      previousMajor = null;
      lastSpacing = null;
      settings = WORKPLANE_DEFAULTS;
      status = null;
      emit();
    },
    async without(fn) {
      // Counted, so overlapping exports each keep the plane hidden until the last ends.
      hideDepth++;
      drawing?.setVisible(false);
      try {
        return await fn();
      } finally {
        hideDepth--;
        if (hideDepth === 0) drawing?.setVisible(true);
      }
    },
    figureNote() {
      return drawn && hideDepth === 0 ? workplaneFigureNote(buildView().readout) : null;
    },
    refresh,
    reframe() {
      lastKeyNums.length = 0;
      refresh();
      emit();
    },
    dispose() {
      stopPicking();
      unsubscribeFrames();
      releaseGpu();
      disposed = true;
    },
  };
}
