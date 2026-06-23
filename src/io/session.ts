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
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { BoxBounds } from '../render/measure/geometry';
import type { ClipBox, ClipMode } from '../render/clip/clipBox';

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
export const SESSION_VERSION = 5;

/** Schema versions `parseSession` can read. */
const SUPPORTED_VERSIONS: readonly number[] = [1, 2, 3, 4, 5];

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
  /**
   * v4 — the resolved CRS at export time, including its provenance
   * (source, confidence, userConfirmed flag, optional WKT). On import
   * the Viewer can re-seed its detector with this resolved value so
   * the user's earlier CRS choice round-trips without re-prompting.
   *
   * Strictly additive: a v3 file omits it; the Viewer falls back to its
   * own detection. A v4 file with a malformed `crs` field is parsed
   * tolerantly (dropped, not throwing) so a partly-broken file still
   * imports the parts that ARE valid.
   */
  crs?: ResolvedCrs;
  /**
   * v5 — the class-visibility filter at export time, as the list of ASPRS class
   * codes that were HIDDEN (0..255). On import the Viewer re-applies the filter
   * so a shared recipe reproduces "ground only" / "vegetation hidden" exactly as
   * the author left it. Strictly additive: absent ⇒ no filter (all classes
   * visible), the pre-v5 behaviour; an out-of-range or malformed entry is
   * dropped rather than throwing.
   */
  classFilter?: number[];
  /**
   * v5 — the clipping box at export time (region + mode + enabled). On import
   * the Viewer restores the clip so a shared recipe reproduces an isolation
   * slice or cut-away exactly. Strictly additive and tolerantly parsed: a
   * malformed box is dropped, not thrown.
   */
  clip?: ClipBox;
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
/** The canonical inspection-session file extension (JSON content inside). */
export const SESSION_EXTENSION = '.olvsession';

/**
 * True when a file is an inspection session (a saved analysis) rather than a
 * point-cloud scan. The single detector every entry point uses to route a
 * dropped/opened file to the session loader vs the cloud loader, so there's one
 * answer to "is this a session?" instead of three.
 */
export function isSessionFile(name: string): boolean {
  return name.toLowerCase().endsWith(SESSION_EXTENSION);
}

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
  if (session.crs) doc.crs = session.crs;
  // v5 — class-visibility filter. Only emitted when something is actually
  // hidden, so an unfiltered session keeps the pre-v5 byte-shape.
  const hidden = sanitizeClassFilter(session.classFilter);
  if (hidden.length > 0) doc.classFilter = hidden;
  // v5 — the clipping box, only when one is present (enabled or not, so a
  // disabled-but-positioned clip round-trips its geometry).
  if (session.clip) doc.clip = session.clip;
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
  // v4 — the resolved CRS at export time. Tolerantly parsed; a
  // malformed object is dropped without throwing so the rest of the
  // session still imports.
  const crs = parseResolvedCrs(raw.crs);
  if (crs) out.crs = crs;
  // v5 — class-visibility filter (hidden ASPRS codes). Tolerantly sanitised:
  // non-array, or out-of-range / duplicate entries are dropped, never thrown.
  const classFilter = sanitizeClassFilter(raw.classFilter);
  if (classFilter.length > 0) out.classFilter = classFilter;
  // v5 — the clipping box. Dropped (not thrown) if the box geometry is malformed.
  const clip = parseClipBox(raw.clip);
  if (clip) out.clip = clip;
  return out;
}

// --- validation helpers ----------------------------------------------------

const CLIP_MODES: readonly ClipMode[] = ['keep-inside', 'keep-outside'];

/**
 * Parse a persisted clipping box, or `null` when malformed. Requires two finite
 * Vec3 corners; an unknown mode falls back to `keep-inside` and a non-boolean
 * `enabled` falls back to `false`, so a partly-broken clip still imports its
 * geometry rather than failing the whole session.
 */
function parseClipBox(v: unknown): ClipBox | null {
  if (!isRecord(v)) return null;
  const b = v.box;
  if (!isRecord(b) || !isVec3(b.min) || !isVec3(b.max)) return null;
  const box: BoxBounds = {
    min: [b.min[0], b.min[1], b.min[2]],
    max: [b.max[0], b.max[1], b.max[2]],
  };
  const mode: ClipMode = CLIP_MODES.includes(v.mode as ClipMode)
    ? (v.mode as ClipMode)
    : 'keep-inside';
  return { box, mode, enabled: v.enabled === true };
}

/**
 * Normalise a class-filter list to sorted, de-duplicated integer ASPRS codes in
 * 0..255. Anything that isn't an array of such codes collapses to `[]`, so a
 * malformed field round-trips as "no filter" instead of throwing.
 */
function sanitizeClassFilter(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<number>();
  for (const e of v) {
    if (typeof e !== 'number' || !Number.isInteger(e) || e < 0 || e > 255) continue;
    seen.add(e);
  }
  return [...seen].sort((a, b) => a - b);
}

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

const CRS_KINDS = ['local', 'projected', 'geographic', 'unknown'] as const;
const CRS_SOURCES = [
  'las-vlr',
  'copc-meta',
  'ept-srs',
  'catalog-tile',
  'user-override',
  'default-assumption',
] as const;
const CRS_CONFIDENCES = ['high', 'medium', 'low', 'none'] as const;
const CRS_LINEAR_UNITS = ['metre', 'foot', 'us-survey-foot', 'unknown'] as const;

/**
 * Tolerantly parse the v4 `crs` field. Returns null when the object is
 * missing, not a record, or fails the required-field set. Optional fields
 * (`epsg`, `wkt`) are dropped individually on bad shape; the rest of the
 * resolved CRS still imports. This matches the "v3 optional fields"
 * discipline — a partly-broken record never blocks the rest of the
 * session.
 */
function parseResolvedCrs(v: unknown): ResolvedCrs | null {
  if (!isRecord(v)) return null;
  // Required fields.
  if (typeof v.name !== 'string' || v.name.length === 0) return null;
  if (typeof v.kind !== 'string' || !CRS_KINDS.includes(v.kind as never)) return null;
  if (typeof v.source !== 'string' || !CRS_SOURCES.includes(v.source as never)) return null;
  if (typeof v.confidence !== 'string' || !CRS_CONFIDENCES.includes(v.confidence as never)) return null;
  if (typeof v.linearUnit !== 'string' || !CRS_LINEAR_UNITS.includes(v.linearUnit as never)) {
    return null;
  }
  if (!isFiniteNumber(v.linearUnitToMetres)) return null;
  if (typeof v.userConfirmed !== 'boolean') return null;
  const out: ResolvedCrs = {
    kind: v.kind as ResolvedCrs['kind'],
    name: v.name,
    linearUnit: v.linearUnit as ResolvedCrs['linearUnit'],
    linearUnitToMetres: v.linearUnitToMetres,
    source: v.source as ResolvedCrs['source'],
    confidence: v.confidence as ResolvedCrs['confidence'],
    userConfirmed: v.userConfirmed,
    ...(isFiniteNumber(v.epsg) ? { epsg: v.epsg } : {}),
    ...(typeof v.wkt === 'string' && v.wkt.length > 0 ? { wkt: v.wkt } : {}),
  };
  return out;
}
