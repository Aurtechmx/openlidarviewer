/**
 * session.ts
 *
 * The OpenLiDARViewer inspection-session file format — a single JSON document
 * carrying saved camera views, placed measurements, and annotations, so a
 * working inspection can be exported to a file and imported again later.
 *
 * Schema v2 supersedes the original measurement-session format (v1): it
 * adds annotations and gives saved views names. `parseSession` reads BOTH
 * versions, so every legacy session still imports with no loss — a v1 file
 * simply yields zero annotations and views with generated names.
 *
 * Pure — no three.js, no DOM — unit-tested in Node. (The render-layer types it
 * imports, `Measurement` / `Annotation` and friends, are themselves pure.)
 */

import type { Measurement, MeasurementKind, UnitSystem, Vec3 } from '../render/measure/types';
import { MIN_POINTS } from '../render/measure/types';
import type { Annotation, SavedCameraState, Vec3Object } from '../render/annotate/types';
import { freshAnnotationId, isAnnotationType } from '../render/annotate/types';
import type { ColorMode } from '../render/colorModes';
import type { PointSizeMode } from '../render/pointStyle';

/**
 * Current session-file schema version. Bumps to v3, adding:
 *   • the live camera state (not just saved views) so a re-import lands
 *     the viewer on the exact viewpoint the user saved;
 *   • render settings (point size, EDL, antialiasing, size mode) so the
 *     visual style is preserved across the round trip;
 *   • the active colour mode (RGB / intensity / elevation / etc.);
 *   • an optional cached scan-summary block (filename, point count, bounds,
 *     density, CRS label) that makes the file self-describing — open the
 *     .olvsession in a text editor and you can tell which scan it was
 *     captured against without loading anything.
 *
 * Older v1 + v2 files parse with no loss — the new optional fields just
 * read as undefined, and the Viewer falls back to its current state.
 */
export const SESSION_VERSION = 3;

/** Schema versions `parseSession` can read. */
const SUPPORTED_VERSIONS: readonly number[] = [1, 2, 3];

/** the render-style snapshot the v3 schema captures. */
export interface SessionRenderSettings {
  pointSize: number;
  edlEnabled: boolean;
  edlStrength: number;
  pointSizeMode: PointSizeMode;
  antialiasing: boolean;
}

/**
 * a cached scan-summary block, optional. Lets the file be self-
 * describing (an analyst opening the .olvsession years later sees what
 * scan it captured) without requiring the source scan to be available.
 */
export interface SessionScanSummary {
  /** Source file display name. */
  fileName: string;
  /** Source point count. */
  sourcePoints: number;
  /** Source extents in metres: width × depth × height. */
  width: number;
  depth: number;
  height: number;
  /** CRS label, when known. */
  crs?: string;
  /** Linear unit label, when known. */
  crsUnit?: string;
}

/** A named, saved camera viewpoint. */
export interface SavedView {
  name: string;
  camera: SavedCameraState;
}

/** A serialised OpenLiDARViewer inspection session. */
export interface InspectionSession {
  app: 'OpenLiDARViewer';
  /** Kept as `measurement-session` so the format change is purely additive. */
  kind: 'measurement-session';
  version: number;
  /** Vertical axis of the scan the session was captured in. */
  upAxis: 'y' | 'z';
  /** The cloud origin, so local coordinates can be made absolute on import. */
  origin: Vec3;
  /** Unit system that was active at export time. */
  unitSystem: UnitSystem;
  /** Saved camera viewpoints. */
  views: SavedView[];
  /** Placed measurements (vertices in local coordinates). */
  measurements: Measurement[];
  /** Placed annotations (positions in local coordinates). */
  annotations: Annotation[];
  /**
   * v3 — the live camera at export time (separate from `views`, which holds
   * the named bookmarks). On import the viewer flies to this pose, so the
   * round-trip preserves "where I was looking when I saved".
   */
  camera?: SavedCameraState;
  /** v3 — point-style + EDL + antialiasing snapshot. */
  render?: SessionRenderSettings;
  /** v3 — the colour mode that was active at export time. */
  colorMode?: ColorMode;
  /**
   * v3 — cached source-scan metadata. Optional; useful for self-describing
   * `.olvsession` files (`fileName`, `sourcePoints`, extents, CRS label).
   */
  scanSummary?: SessionScanSummary;
}

const KINDS: readonly MeasurementKind[] = [
  'distance',
  'polyline',
  'area',
  'height',
  'angle',
  'slope',
];

/**
 * Serialise a session to a pretty-printed JSON string (always the current
 * `SESSION_VERSION` — currently v3). v3 optional fields
 * (`camera`, `render`, `colorMode`, `scanSummary`) are included whenever
 * the caller supplied them; absent fields are omitted from the JSON to
 * keep the v1/v2 baseline byte-shape unchanged for files that don't use
 * the new surface.
 */
export function serializeSession(
  session: Omit<InspectionSession, 'app' | 'kind' | 'version'>,
): string {
  const doc: InspectionSession = {
    app: 'OpenLiDARViewer',
    kind: 'measurement-session',
    version: SESSION_VERSION,
    upAxis: session.upAxis,
    origin: session.origin,
    unitSystem: session.unitSystem,
    views: session.views,
    measurements: session.measurements,
    annotations: session.annotations,
  };
  if (session.camera) doc.camera = session.camera;
  if (session.render) doc.render = session.render;
  if (session.colorMode) doc.colorMode = session.colorMode;
  if (session.scanSummary) doc.scanSummary = session.scanSummary;
  return JSON.stringify(doc, null, 2);
}

/**
 * Parse and validate a session JSON string. Throws an `Error` with a clear,
 * user-facing message on anything structurally wrong; individual malformed
 * measurements or annotations are dropped rather than failing the whole
 * import. Schema v1 (measurement-only) and v2 are both accepted.
 */
export function parseSession(text: string): InspectionSession {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!isRecord(raw)) {
    throw new Error('Session file is empty or malformed.');
  }
  if (raw.app !== 'OpenLiDARViewer' || raw.kind !== 'measurement-session') {
    throw new Error('This file is not an OpenLiDARViewer session.');
  }
  if (typeof raw.version !== 'number' || !SUPPORTED_VERSIONS.includes(raw.version)) {
    throw new Error(`Unsupported session version: ${String(raw.version)}.`);
  }
  const out: InspectionSession = {
    app: 'OpenLiDARViewer',
    kind: 'measurement-session',
    version: SESSION_VERSION,
    upAxis: raw.upAxis === 'z' ? 'z' : 'y',
    origin: parseVec3(raw.origin),
    unitSystem: raw.unitSystem === 'imperial' ? 'imperial' : 'metric',
    views: parseViews(raw.views),
    measurements: parseMeasurements(raw.measurements),
    annotations: parseAnnotations(raw.annotations),
  };
  // v3 optional fields — older files leave them as undefined, the Viewer
  // falls back to its current state. Malformed fields are dropped (not
  // throwing) so a partly-broken v3 file still imports the parts that
  // ARE valid.
  if (isRecord(raw.camera)) out.camera = parseCameraState(raw.camera);
  const render = parseRenderSettings(raw.render);
  if (render) out.render = render;
  if (typeof raw.colorMode === 'string' && isColorMode(raw.colorMode)) {
    out.colorMode = raw.colorMode;
  }
  const scanSummary = parseScanSummary(raw.scanSummary);
  if (scanSummary) out.scanSummary = scanSummary;
  return out;
}

// --- validation helpers ----------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isVec3(p: unknown): p is Vec3 {
  return Array.isArray(p) && p.length === 3 && p.every(isFiniteNumber);
}

function parseVec3(v: unknown): Vec3 {
  return isVec3(v) ? [v[0], v[1], v[2]] : [0, 0, 0];
}

/** Parse a `{ x, y, z }` coordinate object, or `null` when malformed. */
function parseVec3Object(v: unknown): Vec3Object | null {
  if (!isRecord(v)) return null;
  if (isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.z)) {
    return { x: v.x, y: v.y, z: v.z };
  }
  return null;
}

/** Parse a camera state — position and target, with optional mode and FOV. */
function parseCameraState(v: unknown): SavedCameraState {
  const o = isRecord(v) ? v : {};
  const state: SavedCameraState = {
    position: parseVec3(o.position),
    target: parseVec3(o.target),
  };
  if (o.mode === 'orbit' || o.mode === 'walk' || o.mode === 'fly') state.mode = o.mode;
  if (isFiniteNumber(o.fov)) state.fov = o.fov;
  return state;
}

/**
 * Parse saved views. A v2 view is `{ name, camera }`; a v1 view is a bare
 * camera pose `{ position, target }`. Both are accepted, and a view with no
 * name is given a generated one.
 */
function parseViews(v: unknown): SavedView[] {
  if (!Array.isArray(v)) return [];
  const out: SavedView[] = [];
  v.forEach((item, i) => {
    if (!isRecord(item)) return;
    const name =
      typeof item.name === 'string' && item.name.trim().length > 0
        ? item.name
        : `View ${i + 1}`;
    // v2 form: a nested `camera`. v1 form: position/target on the item itself.
    const camera = isRecord(item.camera) ? item.camera : item;
    out.push({ name, camera: parseCameraState(camera) });
  });
  return out;
}

function parseMeasurements(v: unknown): Measurement[] {
  if (!Array.isArray(v)) return [];
  const out: Measurement[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const kind = item.kind;
    if (typeof kind !== 'string' || !KINDS.includes(kind as MeasurementKind)) continue;
    const k = kind as MeasurementKind;
    const points = Array.isArray(item.points)
      ? item.points.filter(isVec3).map((p): Vec3 => [p[0], p[1], p[2]])
      : [];
    if (points.length < MIN_POINTS[k]) continue;
    out.push({
      id: typeof item.id === 'string' ? item.id : freshMeasurementId(),
      kind: k,
      name: typeof item.name === 'string' ? item.name : k,
      points,
      closed: item.closed === true ? true : undefined,
    });
  }
  return out;
}

function parseAnnotations(v: unknown): Annotation[] {
  if (!Array.isArray(v)) return [];
  const out: Annotation[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    // An annotation with no valid position is meaningless — drop it.
    const local = parseVec3Object(item.localPosition);
    if (!local) continue;

    const created = isFiniteNumber(item.createdAt) ? item.createdAt : Date.now();
    const updated = isFiniteNumber(item.updatedAt) ? item.updatedAt : created;
    const annotation: Annotation = {
      id: typeof item.id === 'string' && item.id.length > 0 ? item.id : freshAnnotationId(),
      title: typeof item.title === 'string' && item.title.length > 0 ? item.title : 'Annotation',
      type: isAnnotationType(item.type) ? item.type : 'note',
      createdAt: created,
      updatedAt: updated,
      localPosition: local,
    };
    if (typeof item.note === 'string' && item.note.length > 0) annotation.note = item.note;
    const world = parseVec3Object(item.worldPosition);
    if (world) annotation.worldPosition = world;
    if (isRecord(item.cameraState)) annotation.cameraState = parseCameraState(item.cameraState);
    if (typeof item.linkedMeasurementId === 'string') {
      annotation.linkedMeasurementId = item.linkedMeasurementId;
    }
    out.push(annotation);
  }
  return out;
}

/** A reasonably unique measurement id — `crypto.randomUUID`, else a fallback. */
function freshMeasurementId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `m_${Math.random().toString(36).slice(2, 11)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// v3 helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Type guard for the runtime's ColorMode union. */
function isColorMode(v: string): v is ColorMode {
  return v === 'rgb' || v === 'intensity' || v === 'elevation'
      || v === 'classification' || v === 'normal';
}

/** Type guard for the runtime's PointSizeMode union. */
function isPointSizeMode(v: unknown): v is PointSizeMode {
  return v === 'fixed' || v === 'adaptive';
}

/**
 * Parse a v3 render-settings block. Returns `null` if the block is missing,
 * malformed, or carries no recognisable fields. Each individual field is
 * defensively parsed so a partial block still yields what's valid (e.g.
 * a missing `edlStrength` doesn't drop the rest).
 */
function parseRenderSettings(v: unknown): SessionRenderSettings | null {
  if (!isRecord(v)) return null;
  // Demand at least one valid field — otherwise the block is meaningless.
  const hasAny =
    isFiniteNumber(v.pointSize) ||
    typeof v.edlEnabled === 'boolean' ||
    isFiniteNumber(v.edlStrength) ||
    isPointSizeMode(v.pointSizeMode) ||
    typeof v.antialiasing === 'boolean';
  if (!hasAny) return null;
  return {
    pointSize: isFiniteNumber(v.pointSize) ? v.pointSize : 1.5,
    edlEnabled: typeof v.edlEnabled === 'boolean' ? v.edlEnabled : false,
    edlStrength: isFiniteNumber(v.edlStrength) ? v.edlStrength : 0.4,
    pointSizeMode: isPointSizeMode(v.pointSizeMode) ? v.pointSizeMode : 'adaptive',
    antialiasing: typeof v.antialiasing === 'boolean' ? v.antialiasing : true,
  };
}

/** Parse the optional self-describing scan-summary block. */
function parseScanSummary(v: unknown): SessionScanSummary | null {
  if (!isRecord(v)) return null;
  if (typeof v.fileName !== 'string') return null;
  if (!isFiniteNumber(v.sourcePoints)) return null;
  if (!isFiniteNumber(v.width) || !isFiniteNumber(v.depth) || !isFiniteNumber(v.height)) {
    return null;
  }
  const out: SessionScanSummary = {
    fileName: v.fileName,
    sourcePoints: v.sourcePoints,
    width: v.width,
    depth: v.depth,
    height: v.height,
  };
  if (typeof v.crs === 'string' && v.crs.length > 0) out.crs = v.crs;
  if (typeof v.crsUnit === 'string' && v.crsUnit.length > 0) out.crsUnit = v.crsUnit;
  return out;
}
