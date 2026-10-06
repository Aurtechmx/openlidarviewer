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
 * layer shares. When the layers share no datum the plane is placed and read
 * out in scene coordinates instead, and the readout says so.
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
  fadeAlphas,
  patchFor,
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
  /** Lowest and highest elevation in the scan, source units. */
  elevationExtent(): { min: number; max: number } | null;
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
  setAlphas(kind: WorkplaneKind, alphas: Float32Array): void;
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
  let lastKey = '';
  let lastSpacing: (GridSpacing & { showMinor: boolean }) | null = null;
  let lastGeom: WorkplaneGeometry | null = null;
  let lastPlane: WorkplaneBasis | null = null;
  let lastPose = '';
  let drawn = false;
  let hidden = false;
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

  /** The visible scan's box in source coordinates, or null. */
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
      if (!r.ok) return null;
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
      elevationSource: settings.elevationSource,
      spacing: plane && lastSpacing ? { ...lastSpacing, fixed: settings.fixedSpacing !== null } : null,
      units,
      datumKnown: datumKnown(),
    });
    return {
      settings,
      originH: settings.originH ?? (major !== null ? originH : null),
      units,
      axisNames: axisNames(),
      readout,
      status,
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
    lastKey = '';
    lastGeom = null;
    lastPose = '';
  };

  /** Apply the per-vertex fade for the current camera to every line set. */
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
      drawing.setAlphas(kind, fadeAlphas(lastGeom[kind], lastGeom, lastPlane, fadeCam));
    }
  };

  /** Recompute spacing, patch and fade from the camera; rebuild only when the lines change. */
  const refresh = (): void => {
    if (disposed) return;
    const viewer = deps.viewer();
    const provisional = settings.enabled && viewer && hasScan() ? planeOf(settings, null) : null;
    const box = sourceBox();
    if (!provisional || !viewer || !box) {
      if (drawing) releaseGpu();
      lastSpacing = null;
      return;
    }
    const cam = viewer.getCameraState();
    const sceneOrigin = datum();
    const h = deps.canvas.clientHeight || 1;
    const camIn = { position: cam.position, target: cam.target, fovDeg: cam.fov ?? DEFAULT_FOV, orthographic: viewer.orthographic };
    const first = sampleWorkplaneView(camIn, provisional.basis, sceneOrigin, h);
    const spacing =
      settings.fixedSpacing !== null
        ? fixedSpacing(settings.fixedSpacing)
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
    const corners: Vec3[] = [];
    for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) corners.push([x, y, z]);
    const st = corners.map((c) => planeCoordsOf(c, b));
    const boxPlane = [
      Math.min(...st.map((p) => p[0])),
      Math.max(...st.map((p) => p[0])),
      Math.min(...st.map((p) => p[1])),
      Math.max(...st.map((p) => p[1])),
    ] as const;
    const scanSize = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
    const patch = patchFor(boxPlane, scanSize, sample.focus, spacing.major);
    const key = [spacing.major, spacing.minor, showMinor, patch.iMin, patch.iMax, patch.jMin, patch.jMax, ...b.origin, ...b.normal, ...b.u, ...sceneOrigin].join('|');
    lastSpacing = { ...spacing, showMinor };
    drawing ??= deps.makeDrawing(viewer.derivedLayerHost());
    drawing.setBackdrop(deps.lightBackdrop() ? 'light' : 'dark');
    const pose = [...cam.position, ...cam.target, cam.fov ?? DEFAULT_FOV, viewer.orthographic, h].join('|');
    if (key === lastKey) {
      if (pose !== lastPose) {
        lastPose = pose;
        applyFade(cam, viewer.orthographic);
      }
      return;
    }
    lastKey = key;
    lastPose = pose;
    lastPlane = b;
    lastGeom = buildWorkplaneGeometry({ plane: b, patch, major: spacing.major, minor: spacing.minor, showMinor, sceneOrigin });
    drawing.update(lastGeom);
    applyFade(cam, viewer.orthographic);
    drawing.setVisible(!hidden);
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
    lastKey = '';
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
      apply({ ...settings, originH: [p[a], p[b]], elevation: elevationOf(p, axis()), elevationSource: 'picked' }, 'Origin and elevation set from the picked point.');
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
      if (!Number.isFinite(east) || !Number.isFinite(north)) {
        status = 'The origin needs two finite numbers.';
        emit();
        return;
      }
      apply({ ...settings, originH: [east, north], ...(settings.orientation === 'three-point' ? { elevation: null } : {}) });
    },
    setElevation(value) {
      if (!Number.isFinite(value)) {
        status = 'The elevation needs a finite number.';
        emit();
        return;
      }
      apply({ ...settings, elevation: value, elevationSource: 'typed' });
    },
    setFixedSpacing(major) {
      if (major !== null && !(Number.isFinite(major) && major > 0)) {
        status = 'A fixed spacing needs a number above zero.';
        emit();
        return;
      }
      apply({ ...settings, fixedSpacing: major });
    },
    useScanMinimum() {
      const ext = deps.viewer()?.elevationExtent();
      if (!ext || !Number.isFinite(ext.min)) {
        status = 'No scan is open to take a minimum from.';
        emit();
        return;
      }
      apply({ ...settings, elevation: ext.min, elevationSource: 'scan-minimum' }, 'Elevation set to the lowest point in the scan. That is not ground.');
    },
    beginPick(kind) {
      if (!hasScan()) {
        status = 'Open a scan first, then pick on its points.';
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
      apply(next);
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
      if (!drawing || !drawn) return fn();
      hidden = true;
      drawing.setVisible(false);
      try {
        return await fn();
      } finally {
        hidden = false;
        drawing?.setVisible(true);
      }
    },
    figureNote() {
      return drawn && !hidden ? workplaneFigureNote(buildView().readout) : null;
    },
    refresh,
    reframe() {
      lastKey = '';
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
