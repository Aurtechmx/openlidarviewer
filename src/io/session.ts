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

import type {
  Measurement,
  MeasurementKind,
  ProfileChartSample,
  UnitSystem,
  Vec3,
  VolumeRecord,
} from '../render/measure/types';
import { MIN_POINTS } from '../render/measure/types';
import type {
  ProfileClassificationKind,
  ProfileProvenance,
  ProfileUnitContext,
} from '../render/measure/profileProvenance';
import type { ProfileSectionScope } from '../render/measure/profileSectionSnapshot';
import type { MeasurementTrust, TrustGrade } from '../render/measure/measurementTrust';
import type { Annotation, SavedCameraState, Vec3Object } from '../render/annotate/types';
import { freshAnnotationId, isAnnotationType } from '../render/annotate/types';
import { parseIssueDetails } from '../render/annotate/issueWorkflow';
import type { ColorMode } from '../render/colorModes';
import type { PointSizeMode } from '../render/pointStyle';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { CrsLinearUnit } from './crs';
import type { BoxBounds } from '../render/measure/geometry';
import type { ClipBox, ClipMode } from '../render/clip/clipBox';
import { parseResolvedCrs } from './sessionCrs';
import {
  assertOwnershipWithinFrame,
  frameAnchorLayerId,
  parseSessionProjectFrame,
  serializeSessionProjectFrame,
} from './sessionFrame';
import type { SessionProjectFrame } from './sessionFrame';
import { parseWorkOwnership, serializeWorkOwnership } from '../model/workOwnership';
import type { WorkOwnership } from '../model/workOwnership';

/**
 * Current session-file schema version (v8). The history, oldest first: v3 added
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
 * v7 turns each saved view from a camera bookmark into a restorable view
 * STATE: a view may carry the same display bundle the session records
 * globally (clip box, colour mode, class filter, point-filter windows,
 * render settings), so a paper can cite "Figure 3 = view state
 * 'north-scarp'" and a reviewer regenerates that exact framing AND display.
 * v7 also reserves the top-level `processingManifest` slot (opaque
 * passthrough) so the verifiable-processing workstream can populate it
 * without another version bump.
 *
 * v8 adds the PROJECT FRAME: one project origin plus a record per layer
 * (stable id, source fingerprint, display name, source origin, the Float64
 * transform into the project frame, CRS, up axis), and per-item ownership on
 * measurements and annotations. Through v7 a session described one scan with
 * one origin, so saved work had no way to say which layer it belonged to,
 * which is why multi-layer mounting is disabled. v8 is the persistence half of
 * removing that block; the mount flag itself stays off (see `LayerService.ts`).
 *
 * The per-annotation inspection workflow (`annotation.issue` — severity,
 * open/resolved status, observation date) is additive WITHIN v8 and carries no
 * bump. It adds one optional field, changes the meaning of none, and is only
 * emitted for annotations that have one, so a session with no issues keeps its
 * byte-shape exactly; a reader that predates it ignores an unknown key and
 * still gets every annotation. Bumping would instead make every file this app
 * writes unreadable to a v8 reader for a field that reader never needed.
 *
 * The Layers panel's groups (`layerGroups` — name, collapsed flag, and member
 * STABLE layer ids) are additive within v8 on the same terms, and are emitted
 * only when a group exists.
 *
 * A profile measurement's provenance record (`measurement.profileProvenance` —
 * method, corridor version, sources by STABLE layer id, class policy, coverage,
 * units; see `render/measure/profileProvenance.ts`) is additive within v8 on
 * those same terms. It is one optional field on one measurement kind, emitted
 * only for a profile that carries one, so a session without one keeps its
 * byte-shape; a session that predates it parses with the field undefined and
 * loses nothing. It holds counts and identity only, never the accepted returns,
 * so it cannot grow with the size of the cloud it describes.
 *
 * Older v1..v7 files parse with no loss: the new optional fields just
 * read as undefined, and the Viewer falls back to its current state. A v7
 * file's work carries no owner, and `io/sessionOwnership.ts` attributes it to
 * the anchor layer with the assignment MARKED inferred rather than asserted.
 */
export const SESSION_VERSION = 8;

/** Schema versions `parseSession` can read. */
const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

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
  /**
   * Source extents in the scan's OWN CRS linear units (width × depth × height) —
   * NOT metres. The writer stores the raw bounding-box spans (`b.max - b.min`)
   * with no unit conversion, so a foot-CRS scan records feet here. The unit is
   * disclosed by {@link crsUnit}; a metre value is never asserted. These raw
   * spans are what `matchSessionToScan` compares (`extentRelDiff`), so the
   * stored values must stay unconverted — this is a documentation correction
   * only, not a value change.
   */
  width: number;
  depth: number;
  height: number;
  /** CRS label, when known. */
  crs?: string;
  /**
   * Horizontal EPSG code, when known. Labels vary for one CRS, so the label
   * comparison is disclosure-only; CODES are canonical, so a difference here
   * is a conflict — a session made in one frame must not restore onto a scan
   * declaring another.
   */
  epsg?: number;
  /** Linear unit label, when known. */
  crsUnit?: string;
}

/** Inclusive `[min, max]` point-filter windows persisted with a session. */
export interface SessionPointFilters {
  /** Elevation window in world/source units. */
  elevation?: readonly [number, number];
  /** Intensity window in raw intensity units. */
  intensity?: readonly [number, number];
}

/**
 * One layer group as a session records it.
 *
 * Membership is stored by STABLE layer id — the source-fingerprint identity
 * `model/layerIdentity.ts` mints and `owner` already uses — never by the
 * viewer's `cloud_N` handle. A viewer id is a slot number: reopening the same
 * project in another order would hand `cloud_1` to a different file, and the
 * group would silently restore around the wrong scan. A layer that carries no
 * proven identity is therefore left out of the written membership rather than
 * written under an id that means nothing next session.
 */
export interface SessionLayerGroup {
  /** The group's stable id, as minted by `LayerGroupStore`. */
  id: string;
  /** Display label. Non-blank; not required to be unique. */
  name: string;
  /** Whether the panel drew the group folded shut. Omitted when false. */
  collapsed?: boolean;
  /** Member STABLE layer ids, in join order. */
  memberIds: string[];
}

/**
 * v7 — everything a restorable view state carries. The session records this
 * bundle twice: once GLOBALLY (the flat optional fields on
 * {@link InspectionSession}, the live state at export time) and once PER
 * SAVED VIEW (the optional fields on {@link SavedView}), both through the
 * same sub-parsers so the two surfaces can never drift. `camera` is optional
 * here because a saved view keeps its camera in the required
 * `SavedView.camera` slot; the global path fills it in.
 *
 * Streaming honesty: restoring a bundle re-applies settings and re-renders —
 * on a streaming (COPC/EPT) cloud the resident node set varies with budget
 * and load order, so byte-identical point MEMBERSHIP is not guaranteed, only
 * the same camera/clip/colour/filter recipe over whatever is resident.
 */
export interface ViewStateBundle {
  camera?: SavedCameraState;
  render?: SessionRenderSettings;
  colorMode?: ColorMode;
  /** Hidden ASPRS class codes, same contract as `InspectionSession.classFilter`. */
  classFilter?: number[];
  pointFilters?: SessionPointFilters;
  clip?: ClipBox;
}

/**
 * A named, saved camera viewpoint. Since v7 it may carry the full display
 * bundle (clip, colour mode, class filter, point filters, render settings);
 * a bundle-free view serialises exactly as it did in v6 — `{ name, camera }`,
 * nothing else — so camera-only bookmarks keep their byte-shape.
 */
export interface SavedView extends Omit<ViewStateBundle, 'camera'> {
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
   * v6 — the point-filter windows active at export time: an elevation window
   * (world/source units) and an intensity window (raw units), each an inclusive
   * `[min, max]`. On import the Viewer re-applies them so a recipe reproduces
   * "only the ground band" / "hide the low-return noise" exactly. Strictly
   * additive: absent ⇒ no filter; a malformed window is dropped, not thrown.
   */
  pointFilters?: SessionPointFilters;
  /**
   * v5 — the clipping box at export time (region + mode + enabled). On import
   * the Viewer restores the clip so a shared recipe reproduces an isolation
   * slice or cut-away exactly. Strictly additive and tolerantly parsed: a
   * malformed box is dropped, not thrown.
   */
  clip?: ClipBox;
  /**
   * v6 — the app version that wrote the file (e.g. "0.5.2"). On import the
   * Viewer can tell whether a newer build would interpret the scan differently
   * and prompt the user to re-save. Strictly additive: a pre-v6 file omits it
   * and is treated as "an earlier version" (see `exportStaleness.ts`).
   */
  software?: string;
  /**
   * v7 — RESERVED for the verifiable processing manifest (the record of every
   * derivation applied to the scan, so a reviewer can audit how a published
   * number was produced). The slot is claimed here so the manifest workstream
   * can start writing it WITHOUT another coordinated version bump. Until that
   * lands the field is an opaque passthrough: the serializer emits whatever
   * the caller supplies verbatim, the parser copies it verbatim with no
   * validation, and no reader interprets it. Absent ⇒ omitted from the JSON
   * (byte-shape preserved).
   */
  processingManifest?: unknown;
  /**
   * The loaded layer's STABLE identity (audit item O). Generated at layer
   * creation and anchored on the source fingerprint — never derived from the
   * filename or the display label — so it survives a rename, a duplicate
   * filename, reordering, and this export/import round trip. Strictly additive
   * within v7: a session written before the field existed omits it and the
   * loader leaves it undefined, so the app assigns a fresh id on import. A
   * non-string value is dropped rather than thrown.
   */
  layerId?: string;
  /**
   * The layer's display LABEL at export time, stored separately from identity
   * (`layerId`) so a rename round-trips without ever touching the id. Additive
   * and tolerantly parsed like {@link layerId}.
   */
  layerName?: string;
  /**
   * The Layers panel's groups — the named, collapsible containers a user
   * arranged the loaded scans into, each holding stable layer ids (see
   * {@link SessionLayerGroup}).
   *
   * Additive WITHIN v8, no bump, for the same reason `annotation.issue` needed
   * none: it adds one optional field, changes the meaning of none, and is
   * emitted only when at least one group exists, so a session with no groups
   * keeps its byte-shape exactly and a reader that predates the field ignores
   * an unknown key and still gets every measurement, annotation and view.
   *
   * Tolerantly parsed like the other display fields: a malformed entry is
   * dropped, never thrown. A lost group costs an arrangement of rows; nothing
   * about where geometry is read back depends on it.
   */
  layerGroups?: SessionLayerGroup[];
  /**
   * v8. The project frame: the one origin the project's layers map into, plus
   * a record per layer (see `io/sessionFrame.ts`). Present only for a session
   * that actually describes a project frame; absent means the pre-v8 reading
   * applies, where {@link origin} is the single frame everything is local to.
   *
   * Unlike every other optional field, this one is NOT tolerantly dropped when
   * malformed. A dropped display setting costs a display setting; a dropped or
   * repaired frame changes where saved geometry is read back, invisibly. An
   * inconsistent frame is therefore refused on read and on write.
   */
  projectFrame?: SessionProjectFrame;
}

const KINDS: ReadonlySet<MeasurementKind> = new Set([
  'distance',
  'polyline',
  'area',
  'height',
  'angle',
  'slope',
  // v0.5.6 fix: these were serialized (serializeSession emits the whole
  // Measurement) but the parser's whitelist silently dropped them on import,
  // losing profile / box / volume measurements and their specialised data.
  'profile',
  'box',
  'volume',
]);

/**
 * Serialise a session to a pretty-printed JSON string (always the current
 * `SESSION_VERSION`). Optional fields (`camera`, `render`, `colorMode`,
 * `scanSummary`, and the later additions) are included whenever the caller
 * supplied them; absent fields are omitted from the JSON to keep the
 * earlier-schema byte-shape unchanged for files that don't use the new
 * surface.
 */
// `isSessionFile` + `SESSION_EXTENSION` live in the tiny eager `./sessionFile`
// module so the file router doesn't drag this parser into the initial bundle;
// re-exported here so existing importers keep working.
export { isSessionFile, SESSION_EXTENSION } from './sessionFile';

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
    // v7 — each view re-serialised through the same emit-only-when-set
    // discipline as the top-level fields, so a camera-only view stays
    // byte-identical to its v6 form.
    views: session.views.map(serializeSavedView),
    // v8. Ownership is validated on the way out, never rewritten. Work that
    // carries no owner is passed through as the SAME object, so a session with
    // no ownership keeps its pre-v8 byte-shape exactly.
    measurements: session.measurements.map((m) => withCheckedOwner(m, `Measurement ${m.id}`)),
    annotations: session.annotations.map((a) => withCheckedOwner(a, `Annotation ${a.id}`)),
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
  // v6 — point-filter windows, only the ones actually set.
  const pf = sanitizePointFilters(session.pointFilters);
  if (pf) doc.pointFilters = pf;
  // v5 — the clipping box, only when one is present (enabled or not, so a
  // disabled-but-positioned clip round-trips its geometry).
  if (session.clip) doc.clip = session.clip;
  // v6 — the producing app version, only when the caller supplies it.
  if (typeof session.software === 'string' && session.software !== '') {
    doc.software = session.software;
  }
  // v7 — reserved manifest slot, opaque passthrough (see the field docs).
  // `null` counts as absent so a JSON-roundtripped "no manifest" can't emit
  // a literal null and change the byte-shape.
  if (session.processingManifest != null) {
    doc.processingManifest = session.processingManifest;
  }
  // Stable layer identity (audit item O) — emitted only when set, so a session
  // that carries no id keeps the earlier byte-shape.
  if (typeof session.layerId === 'string' && session.layerId !== '') {
    doc.layerId = session.layerId;
  }
  if (typeof session.layerName === 'string' && session.layerName !== '') {
    doc.layerName = session.layerName;
  }
  // Layer groups — through the same sanitiser the reader uses, so this app can
  // never write an arrangement it would itself drop on the way back in. Only
  // emitted when a group survives, keeping the no-groups byte-shape.
  const groups = sanitizeLayerGroups(session.layerGroups);
  if (groups.length > 0) doc.layerGroups = groups;
  // v8. The project frame, validated here as well as on read, so this app can
  // never write a session it would itself refuse to open.
  if (session.projectFrame) {
    const frame = serializeSessionProjectFrame(session.projectFrame);
    assertOwnershipWithinFrame(frame, doc.measurements, 'measurements');
    assertOwnershipWithinFrame(frame, doc.annotations, 'annotations');
    doc.projectFrame = frame;
  }
  return JSON.stringify(doc, null, 2);
}

/**
 * Pass a measurement or annotation through the ownership check unchanged.
 *
 * Returns the SAME object when there is no owner, which is what keeps the
 * pre-v8 byte-shape intact for work that carries none. An owner that would not
 * survive its own parser throws rather than being dropped: dropping it would
 * turn a stated attribution into an inferred one on the next import, and the
 * work would be read in whatever frame happened to be open.
 */
function withCheckedOwner<T extends { owner?: WorkOwnership }>(item: T, context: string): T {
  if (item.owner === undefined) return item;
  return { ...item, owner: serializeWorkOwnership(item.owner, context) };
}

/**
 * Emit one saved view with the v7 optional bundle applied field-by-field:
 * `name` + `camera` always (the v6 shape), then each bundle field ONLY when
 * it carries something — the same sanitisers as the top-level fields, so an
 * empty class filter or a window-less point-filter block is dropped rather
 * than serialised as noise.
 */
function serializeSavedView(view: SavedView): SavedView {
  const doc: SavedView = { name: view.name, camera: view.camera };
  if (view.render) doc.render = view.render;
  if (view.colorMode) doc.colorMode = view.colorMode;
  const hidden = sanitizeClassFilter(view.classFilter);
  if (hidden.length > 0) doc.classFilter = hidden;
  const pf = sanitizePointFilters(view.pointFilters);
  if (pf) doc.pointFilters = pf;
  if (view.clip) doc.clip = view.clip;
  return doc;
}

/**
 * Parse and validate a session JSON string. Throws an `Error` with a clear,
 * user-facing message on anything structurally wrong; individual malformed
 * measurements or annotations are dropped rather than failing the whole
 * import. Schema v1 (measurement-only) and v2 are both accepted.
 */
/**
 * Read the session's vertical axis, refusing anything else.
 *
 * This decides which component of a rebase delta is elevation (`elevDelta`
 * below), so a wrong value silently reinterprets the height of every restored
 * measurement. The previous `=== 'z' ? 'z' : 'y'` turned a missing, misspelled
 * or corrupted value into Y-up with no warning. Every session this app writes
 * carries an explicit 'y' or 'z', so anything else means the file was
 * hand-edited, truncated or written by something else — none of which is a
 * reason to guess at the vertical axis.
 */
function parseUpAxis(raw: unknown): 'y' | 'z' {
  if (raw === 'z' || raw === 'y') return raw;
  throw new Error(
    `Session up-axis is ${JSON.stringify(raw)}; expected "y" or "z". ` +
      `Refusing rather than guessing, because the up-axis decides which ` +
      `direction every restored measurement treats as elevation.`,
  );
}

// --- session resource ceilings ---------------------------------------------
// A shared, corrupt or hostile `.olvsession` is untrusted input. These cap the
// dimensions an over-large file can blow up on; each is far beyond any real
// session and truncates/rejects BEFORE the value reaches app state. (The whole-
// file byte ceiling is enforced one layer up, in `app/sessionIo.ts`, on the
// File's size before this parser ever reads it.)

/** Hard cap on parsed list lengths (views, measurements, chart samples, annotations) — a hostile/corrupt file can't hang the tab. */
export const MAX_SESSION_ITEMS = 100_000;

/**
 * Cap on a SINGLE measurement's vertex list. A real measurement holds at most a
 * few thousand hand-placed / traced vertices, so a million is orders beyond any
 * legitimate one while still bounding the per-measurement heap: one hostile
 * entry carrying tens of millions of points would otherwise OOM the tab — an
 * allocation the `importSession` try/catch can't catch, because the tab dies
 * first.
 */
export const MAX_MEASUREMENT_POINTS = 1_000_000;

/** Cap on an annotation title's length — a multi-MB string is a DoS, not a label. */
export const MAX_ANNOTATION_TITLE = 512;
/** Cap on an annotation note's length — generous for a paragraph, bounded against abuse. */
export const MAX_ANNOTATION_NOTE = 8_192;

/**
 * Cap on the opaque `processingManifest`'s serialized size. The slot is passed
 * through verbatim (never validated), so a size bound is the only guard on it; a
 * real manifest is a few KB of provenance, so 4 MB is far above any legitimate
 * one while rejecting a slot inflated to exhaust memory.
 */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/** True when the opaque manifest serialises within the byte cap; a non-serialisable or over-cap value is rejected (dropped, treated as absent). */
function withinManifestByteCap(manifest: unknown): boolean {
  try {
    return JSON.stringify(manifest).length <= MAX_MANIFEST_BYTES;
  } catch {
    return false;
  }
}

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
  if (typeof raw.version !== 'number' || !SUPPORTED_VERSIONS.has(raw.version)) {
    throw new Error(`Unsupported session version: ${String(raw.version)}.`);
  }
  const out: InspectionSession = {
    app: 'OpenLiDARViewer',
    kind: 'measurement-session',
    version: SESSION_VERSION,
    upAxis: parseUpAxis(raw.upAxis),
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
  const pointFilters = sanitizePointFilters(raw.pointFilters);
  if (pointFilters) out.pointFilters = pointFilters;
  // v5 — the clipping box. Dropped (not thrown) if the box geometry is malformed.
  const clip = parseClipBox(raw.clip);
  if (clip) out.clip = clip;
  // v6 — the producing app version. A non-string is ignored (treated as absent).
  if (typeof raw.software === 'string' && raw.software !== '') out.software = raw.software;
  // v7 — reserved manifest slot: copied verbatim, never validated (opaque
  // passthrough until the processing-manifest workstream defines its shape).
  // Deliberately version-independent on read so a file that carries one is
  // never stripped by a round-trip.
  // Opaque passthrough (never validated), so the one guard on this untrusted
  // slot is its serialized SIZE — an over-cap manifest is dropped (treated as
  // absent) rather than carried, verbatim, into app state.
  if (raw.processingManifest != null && withinManifestByteCap(raw.processingManifest)) {
    out.processingManifest = raw.processingManifest;
  }
  // Stable layer identity — additive within v7, version-independent on read so a
  // file that carries it is never stripped by a round trip. A non-string is
  // ignored (treated as absent) rather than throwing.
  if (typeof raw.layerId === 'string' && raw.layerId !== '') out.layerId = raw.layerId;
  if (typeof raw.layerName === 'string' && raw.layerName !== '') out.layerName = raw.layerName;
  // Layer groups — additive within v8, version-independent on read like the
  // other additive fields, so a file that carries an arrangement is never
  // stripped by a round trip.
  const layerGroups = sanitizeLayerGroups(raw.layerGroups);
  if (layerGroups.length > 0) out.layerGroups = layerGroups;
  // v8. The project frame. Version-independent on read, like the other
  // additive fields, so a file that carries one is never stripped by a round
  // trip. An inconsistent frame THROWS (see `sessionFrame.ts`): it decides
  // where every owned measurement is read back, so there is nothing safe to
  // fall back to.
  if (raw.projectFrame != null) {
    out.projectFrame = parseSessionProjectFrame(raw.projectFrame);
    assertOwnershipWithinFrame(out.projectFrame, out.measurements, 'measurements');
    assertOwnershipWithinFrame(out.projectFrame, out.annotations, 'annotations');
  }
  return out;
}

/** A session's geometry rebased into a target cloud's local frame. */
export interface RebasedSessionGeometry {
  /**
   * Measurements with vertices shifted into the target frame — including the
   * elevation-only scalars a bare vertex shift misses: profile-chart heights
   * and each volume's reference plane.
   */
  measurements: Measurement[];
  /**
   * Annotations with local positions AND their jump-to-view camera shifted into
   * the target frame.
   */
  annotations: Annotation[];
  /** Saved views with their camera (and per-view clip) shifted into the frame. */
  views: SavedView[];
  /** The live camera shifted into the target frame, when the session had one. */
  camera?: SavedCameraState;
  /** The global clip box shifted into the target frame, when present. */
  clip?: ClipBox;
  /** `session.origin − cloudOrigin`, in f64. All-zero when the frames match. */
  delta: Vec3;
  /**
   * v8. Ids of the measurements and annotations left where they were because
   * their stored ownership says they are NOT in the session's global frame:
   * work already declared project-frame, or owned by a layer other than the one
   * `session.origin` describes. Shifting those by this delta would move them.
   * Empty for every pre-v8 session, where all work shares the one frame.
   */
  unrebased: readonly string[];
}

/**
 * Rebase a session's LOCAL measurement/annotation vertices from the frame they
 * were CAPTURED in (`session.origin`) into the frame of the cloud they are being
 * IMPORTED onto (`cloudOrigin`), so they land at the SAME world position.
 *
 * Both stores keep vertices as `local = world − origin`. A session saved over
 * tile A (origin Oa) imported onto tile B (origin Ob) must shift every vertex by
 * `delta = Oa − Ob`: then `local_b + Ob = local_a + Oa` — identical world
 * coordinates — instead of being displaced by the two origins' difference (the
 * verbatim-load bug, which the exporter would then compound by adding Ob).
 *
 * Pure: returns fresh arrays and vertex copies, never mutating the session. A
 * zero delta (matching frames, or a session/cloud both at the origin) copies
 * the geometry through unchanged.
 */
export function rebaseSessionGeometry(
  session: InspectionSession,
  cloudOrigin: readonly number[],
): RebasedSessionGeometry {
  const dx = session.origin[0] - (cloudOrigin[0] ?? 0);
  const dy = session.origin[1] - (cloudOrigin[1] ?? 0);
  const dz = session.origin[2] - (cloudOrigin[2] ?? 0);
  // Elevation-only scalars (profile-chart heights, a volume reference plane)
  // move by the UP-axis component of the shift, not the full vector.
  const elevDelta = session.upAxis === 'z' ? dz : dy;
  const shiftVec = (v: readonly [number, number, number]): Vec3 => [
    v[0] + dx,
    v[1] + dy,
    v[2] + dz,
  ];
  const shiftCamera = (c: SavedCameraState): SavedCameraState => ({
    ...c,
    position: shiftVec(c.position),
    target: shiftVec(c.target),
  });
  const shiftClip = (c: ClipBox): ClipBox => ({
    ...c,
    box: { min: shiftVec(c.box.min), max: shiftVec(c.box.max) },
  });
  const copyVec = (v: readonly [number, number, number]): Vec3 => [v[0], v[1], v[2]];

  // `session.origin` is the frame of ONE layer, the anchor. Work owned by any
  // other layer, or already declared project-frame, is in a different frame and
  // this delta does not describe it. Pre-v8 work carries no owner and is in the
  // session's single frame by construction, so it rebases exactly as before.
  const anchorLayerId = session.projectFrame
    ? frameAnchorLayerId(session.projectFrame)
    : (session.layerId ?? null);
  const unrebased: string[] = [];
  const inSessionFrame = (owner: WorkOwnership | undefined): boolean => {
    if (!owner) return true;
    if (owner.frame === 'project') return false;
    return anchorLayerId !== null && owner.layerId === anchorLayerId;
  };

  const measurements = session.measurements.map((m) => {
    if (!inSessionFrame(m.owner)) {
      unrebased.push(m.id);
      return { ...m, points: m.points.map(copyVec) };
    }
    const next: Measurement = { ...m, points: m.points.map(shiftVec) };
    if (m.profileChart) {
      next.profileChart = m.profileChart.map((s) => ({
        ...s,
        // A corridor gap serialises as NaN — leave it; only finite heights move.
        height: Number.isFinite(s.height) ? s.height + elevDelta : s.height,
      }));
    }
    if (m.volume) {
      next.volume = { ...m.volume, referenceZ: m.volume.referenceZ + elevDelta };
    }
    return next;
  });
  const annotations = session.annotations.map((a) => {
    if (!inSessionFrame(a.owner)) {
      unrebased.push(a.id);
      return { ...a, localPosition: { ...a.localPosition } };
    }
    // The world (survey) position is frame-INVARIANT: a render-frame rebase
    // shifts the local anchor by `delta` and the active origin by `-delta`, so
    // `local + origin` is unchanged. Honour the "recomputed on load" contract on
    // annotate/types.ts by (re)deriving it here — keep a stored value, else
    // compute it from the OLD local plus the session's capture origin (which
    // equals the rebased local plus the new cloud origin). This is what lets a
    // deliverable report state a real survey coordinate after a reopen.
    const world = a.worldPosition ?? {
      x: a.localPosition.x + session.origin[0],
      y: a.localPosition.y + session.origin[1],
      z: a.localPosition.z + session.origin[2],
    };
    const next: Annotation = {
      ...a,
      localPosition: {
        x: a.localPosition.x + dx,
        y: a.localPosition.y + dy,
        z: a.localPosition.z + dz,
      },
      worldPosition: { x: world.x, y: world.y, z: world.z },
    };
    // The jump-to-view camera is in the same local frame as the vertices.
    if (a.cameraState) next.cameraState = shiftCamera(a.cameraState);
    return next;
  });
  const views = session.views.map((v) => {
    const next: SavedView = { ...v, camera: shiftCamera(v.camera) };
    if (v.clip) next.clip = shiftClip(v.clip);
    return next;
  });
  return {
    measurements,
    annotations,
    views,
    camera: session.camera ? shiftCamera(session.camera) : undefined,
    clip: session.clip ? shiftClip(session.clip) : undefined,
    delta: [dx, dy, dz],
    unrebased,
  };
}

// --- scan-identity guard ----------------------------------------------------

/** The scan facts a session import compares against the loaded cloud. */
export interface ScanFacts {
  /** Source file display name. */
  readonly fileName?: string;
  /** Source point count. */
  readonly sourcePoints?: number;
  /** Source extents (span per axis), in the same units the summary stores. */
  readonly width?: number;
  readonly depth?: number;
  readonly height?: number;
  /** CRS label, when known. */
  readonly crs?: string;
  /** Horizontal EPSG code, when known — canonical where the label is not. */
  readonly epsg?: number;
}

/**
 * How confidently a session's stored scan fingerprint matches the loaded cloud.
 *   strong   — apply the rebase silently.
 *   partial  — apply, but disclose that the match couldn't be fully confirmed.
 *   conflict — refuse: the session was captured over a different scan.
 */
export type ScanMatchVerdict = 'strong' | 'partial' | 'conflict';

export interface ScanMatch {
  readonly verdict: ScanMatchVerdict;
  /** Human-readable evidence, most salient first; empty on a clean strong match. */
  readonly reasons: readonly string[];
}

/** Largest relative difference across the three extent spans, or null if either side lacks them. */
function extentRelDiff(a: ScanFacts, b: ScanFacts): number | null {
  const pairs: Array<[number | undefined, number | undefined]> = [
    [a.width, b.width],
    [a.depth, b.depth],
    [a.height, b.height],
  ];
  let worst = 0;
  for (const [x, y] of pairs) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const denom = Math.max(Math.abs(x as number), Math.abs(y as number), 1e-6);
    worst = Math.max(worst, Math.abs((x as number) - (y as number)) / denom);
  }
  return worst;
}

/**
 * Decide whether a session's stored scan fingerprint matches the loaded cloud,
 * BEFORE its geometry is rebased onto that cloud. Without this, a session
 * captured over scan A is silently realigned onto an unrelated scan B.
 *
 * Extents (the source bounding-box spans) are the primary signal: they identify
 * a scan spatially and are stable under the voxel reduction that fits a large
 * cloud to a device, so a spans mismatch beyond a tolerance is a genuine
 * conflict. Point count corroborates but is NOT a standalone conflict — the same
 * scan reduced for a smaller device legitimately reports fewer points — so a
 * point mismatch only downgrades a would-be strong match to partial. File name
 * and CRS label are softer still (renames and equivalent CRS spellings are
 * common), contributing disclosure reasons but never a verdict on their own.
 *
 * Pure — no DOM, no cloud objects — so it is fully unit-tested in Node.
 */
export function matchSessionToScan(
  summary: SessionScanSummary | undefined,
  loaded: ScanFacts,
): ScanMatch {
  if (!summary) {
    return {
      verdict: 'partial',
      reasons: ['The session carries no scan fingerprint, so its source could not be verified.'],
    };
  }

  const reasons: string[] = [];
  const rel = extentRelDiff(summary, loaded);

  // File name / CRS are disclosure-only signals.
  if (
    summary.fileName &&
    loaded.fileName &&
    summary.fileName.toLowerCase() !== loaded.fileName.toLowerCase()
  ) {
    reasons.push(`the session's scan was “${summary.fileName}”, the loaded scan is “${loaded.fileName}”`);
  }
  // EPSG codes are canonical where labels are not: a differing code means the
  // session's geometry was authored in a different frame, and no amount of
  // matching extents makes rebasing it here honest — the shapes coincide, the
  // coordinates' MEANING does not.
  let crsCodeConflict = false;
  if (
    isFiniteNumber(summary.epsg) &&
    isFiniteNumber(loaded.epsg) &&
    summary.epsg !== loaded.epsg
  ) {
    crsCodeConflict = true;
    reasons.push(`CRS differs (session EPSG:${summary.epsg}, loaded EPSG:${loaded.epsg})`);
  } else if (summary.crs && loaded.crs && summary.crs !== loaded.crs) {
    // Textual CRS labels vary for the same system, so this is disclosure only —
    // never a verdict — but worth surfacing alongside a stronger signal.
    reasons.push(`CRS label differs (session “${summary.crs}”, loaded “${loaded.crs}”)`);
  }

  // Point count — corroborating, tolerant of device reduction.
  let pointsDiffer = false;
  if (
    Number.isFinite(summary.sourcePoints) &&
    Number.isFinite(loaded.sourcePoints) &&
    (summary.sourcePoints as number) > 0 &&
    (loaded.sourcePoints as number) > 0
  ) {
    const a = summary.sourcePoints as number;
    const b = loaded.sourcePoints as number;
    const pr = Math.abs(a - b) / Math.max(a, b);
    if (pr > 0.005) {
      pointsDiffer = true;
      reasons.push(
        `point count differs (session ${a.toLocaleString('en-US')} vs loaded ${b.toLocaleString('en-US')})`,
      );
    }
  }

  if (crsCodeConflict) {
    return { verdict: 'conflict', reasons };
  }
  if (rel === null) {
    // No comparable extents — fall back to whatever softer evidence we have.
    return { verdict: 'partial', reasons };
  }
  if (rel > 0.05) {
    reasons.unshift(`scan extents differ by ${(rel * 100).toFixed(0)}%`);
    return { verdict: 'conflict', reasons };
  }
  if (rel <= 0.01 && !pointsDiffer) {
    return { verdict: 'strong', reasons };
  }
  // Extents agree loosely (1–5%), or agree tightly but the point count moved —
  // consistent with the same scan, not proof of it.
  if (rel > 0.01) reasons.unshift(`scan extents differ by ${(rel * 100).toFixed(1)}%`);
  return { verdict: 'partial', reasons };
}

// --- per-scan spatial-metadata guard (roadmap P1 #5) ------------------------

/**
 * The session's own spatial claims, distilled into a scan-independent bundle so
 * the conflict check reads one shape whatever the session's provenance. `upAxis`
 * is always present (top-level, parsed fail-closed by {@link parseUpAxis}); the
 * CRS code and linear unit come from the session's resolved CRS when it carried
 * one.
 */
export interface SessionSpatialClaims {
  /** Vertical axis the session was captured in. */
  readonly upAxis: 'y' | 'z';
  /** Horizontal EPSG the session declares, when it carried a resolved CRS. */
  readonly epsg?: number;
  /** Linear unit the session's CRS declares; `'unknown'`/absent ⇒ no unit claim. */
  readonly linearUnit?: CrsLinearUnit;
}

/**
 * What the freshly-loaded FILE declares about its own frame — the source of
 * truth a session may not silently redefine. Every field is optional because a
 * file may declare none of them; when it does, that field simply can't conflict
 * and the session's value is free to fill the gap.
 */
export interface DeclaredSpatialFacts {
  /** The file's detected up-axis; `'unknown'`/absent ⇒ the file makes no axis claim. */
  readonly upAxis?: 'y' | 'z' | 'unknown';
  /** The file's horizontal EPSG, when it declares one. */
  readonly epsg?: number;
  /** The file's linear unit; `'unknown'`/absent ⇒ the file makes no unit claim. */
  readonly linearUnit?: CrsLinearUnit;
}

/** Which spatial claim a {@link SpatialClaimConflict} concerns. */
export type SpatialClaimField = 'crs' | 'axis' | 'unit';

/** One proven divergence between the session's spatial claim and the file's. */
export interface SpatialClaimConflict {
  readonly field: SpatialClaimField;
  /** Human-readable evidence, phrased so the file reads as the authority. */
  readonly reason: string;
}

/** The verdict of {@link detectSessionSpatialConflict}. */
export interface SessionSpatialVerdict {
  /** True when the session's spatial metadata contradicts the file's own declaration. */
  readonly hasConflict: boolean;
  /** Every proven contradiction, most-load-bearing (CRS) first; empty on a clean match. */
  readonly conflicts: readonly SpatialClaimConflict[];
}

/** A linear unit that positively names a real metric length (not the inert placeholder). */
function isKnownLinearUnit(u: CrsLinearUnit | undefined): u is Exclude<CrsLinearUnit, 'unknown'> {
  return u != null && u !== 'unknown';
}

/**
 * Compare a session's stored spatial metadata (CRS identity, up-axis, linear
 * unit) against what the freshly-loaded FILE declares, and report every field
 * where they contradict — roadmap P1 #5's fail-closed gate.
 *
 * The rule is asymmetric on purpose: the FILE's own declaration is the source of
 * truth, so a session may only SUPPLY spatial metadata the file leaves blank, it
 * may never REDEFINE metadata the file already carries. A conflict is therefore
 * raised only when BOTH sides positively declare a value AND those values differ
 * (for the axis, when the file names a real axis that differs). When the file
 * declares nothing — no EPSG, an `'unknown'` axis, an `'unknown'` unit — there is
 * no conflict and the session's value fills the gap, exactly as before.
 *
 * The caller (session restore) treats any conflict as a refusal of the session's
 * spatial claim, not a silent adoption of it: it keeps the file's declaration and
 * discloses the disagreement, mirroring how the scan-identity gate refuses a
 * differing EPSG rather than realigning onto it.
 *
 * Pure — no DOM, no cloud objects — so it is fully unit-tested in Node.
 */
export function detectSessionSpatialConflict(
  claims: SessionSpatialClaims,
  declared: DeclaredSpatialFacts,
): SessionSpatialVerdict {
  const conflicts: SpatialClaimConflict[] = [];

  // CRS — canonical EPSG codes: a difference means the coordinates' MEANING
  // differs, so no matching extents make adopting the session's frame honest.
  if (
    isFiniteNumber(claims.epsg) &&
    isFiniteNumber(declared.epsg) &&
    claims.epsg !== declared.epsg
  ) {
    conflicts.push({
      field: 'crs',
      reason: `the session's CRS (EPSG:${claims.epsg}) disagrees with the scan's declared EPSG:${declared.epsg}`,
    });
  }

  // Axis — only when the FILE names a real axis (never on an unknown/undetected
  // one). A differing up-axis reinterprets which component of every restored
  // vertex is elevation, so it can't be adopted silently.
  if (
    (declared.upAxis === 'y' || declared.upAxis === 'z') &&
    declared.upAxis !== claims.upAxis
  ) {
    conflicts.push({
      field: 'axis',
      reason: `the session's up-axis (${claims.upAxis.toUpperCase()}) disagrees with the scan's ${declared.upAxis.toUpperCase()}-up frame`,
    });
  }

  // Unit — only when BOTH sides name a KNOWN unit (an unknown unit is the
  // fail-closed "no claim", never a conflict). Metre vs foot silently rescales
  // every distance, so the file's unit wins.
  if (
    isKnownLinearUnit(claims.linearUnit) &&
    isKnownLinearUnit(declared.linearUnit) &&
    claims.linearUnit !== declared.linearUnit
  ) {
    conflicts.push({
      field: 'unit',
      reason: `the session's linear unit (${claims.linearUnit}) disagrees with the scan's ${declared.linearUnit}`,
    });
  }

  return { hasConflict: conflicts.length > 0, conflicts };
}

// --- validation helpers ----------------------------------------------------

const CLIP_MODES: ReadonlySet<ClipMode> = new Set(['keep-inside', 'keep-outside']);

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
  const mode: ClipMode = CLIP_MODES.has(v.mode as ClipMode)
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

/**
 * Normalise the layer-group list, dropping anything malformed rather than
 * throwing. Both the reader and the writer run it, so a file this app writes is
 * one it would read back identically.
 *
 * Three rules do the work. A group needs an id and a non-blank name, because a
 * nameless row in the panel cannot be told from its neighbours and an id-less
 * one cannot be addressed at all. A group id appearing twice keeps its first
 * occurrence, since handing one id to two groups merges them on import. And
 * membership is EXCLUSIVE across the whole list, matching `LayerGroupStore`: a
 * layer already claimed by an earlier group is dropped from every later one, so
 * a hand-edited file cannot produce two groups issuing contradicting visibility
 * plans for the same layer.
 */
function sanitizeLayerGroups(v: unknown): SessionLayerGroup[] {
  if (!Array.isArray(v)) return [];
  const out: SessionLayerGroup[] = [];
  const groupIds = new Set<string>();
  const claimed = new Set<string>();
  for (const entry of v.slice(0, MAX_SESSION_ITEMS)) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (id === '' || name === '' || groupIds.has(id)) continue;
    groupIds.add(id);
    const memberIds: string[] = [];
    if (Array.isArray(entry.memberIds)) {
      for (const member of entry.memberIds.slice(0, MAX_SESSION_ITEMS)) {
        if (typeof member !== 'string' || member === '' || claimed.has(member)) continue;
        claimed.add(member);
        memberIds.push(member);
      }
    }
    const group: SessionLayerGroup = { id, name, memberIds };
    // Emitted only when folded, so the common expanded case adds no key.
    if (entry.collapsed === true) group.collapsed = true;
    out.push(group);
  }
  return out;
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
  // 'pan' joined the mode union in v0.5.5 (P1 hand tool).
  if (o.mode === 'orbit' || o.mode === 'walk' || o.mode === 'fly' || o.mode === 'pan') state.mode = o.mode;
  if (isFiniteNumber(o.fov)) state.fov = o.fov;
  return state;
}

/**
 * Parse saved views. A v2 view is `{ name, camera }`; a v1 view is a bare
 * camera pose `{ position, target }`. Both are accepted, and a view with no
 * name is given a generated one.
 *
 * v7 — a view may additionally carry the display bundle (clip, colour mode,
 * class filter, point filters, render settings). Each field goes through the
 * SAME tolerant sub-parser as its top-level twin, and each is independently
 * dropped when malformed, so a partly-broken view still restores its name,
 * camera, and whatever else IS valid. A pre-v7 view simply has none of them.
 */
function parseViews(v: unknown): SavedView[] {
  if (!Array.isArray(v)) return [];
  const out: SavedView[] = [];
  // Cap the count, matching the three sibling parsers below — a hostile file
  // can't hang the tab by declaring an unbounded number of views.
  v.slice(0, MAX_SESSION_ITEMS).forEach((item, i) => {
    if (!isRecord(item)) return;
    const name =
      typeof item.name === 'string' && item.name.trim().length > 0
        ? item.name
        : `View ${i + 1}`;
    // v2 form: a nested `camera`. v1 form: position/target on the item itself.
    const camera = isRecord(item.camera) ? item.camera : item;
    const view: SavedView = { name, camera: parseCameraState(camera) };
    const render = parseRenderSettings(item.render);
    if (render) view.render = render;
    if (typeof item.colorMode === 'string' && isColorMode(item.colorMode)) {
      view.colorMode = item.colorMode;
    }
    const classFilter = sanitizeClassFilter(item.classFilter);
    if (classFilter.length > 0) view.classFilter = classFilter;
    const pointFilters = sanitizePointFilters(item.pointFilters);
    if (pointFilters) view.pointFilters = pointFilters;
    const clip = parseClipBox(item.clip);
    if (clip) view.clip = clip;
    out.push(view);
  });
  return out;
}

function parseMeasurements(v: unknown): Measurement[] {
  if (!Array.isArray(v)) return [];
  const out: Measurement[] = [];
  for (const item of v.slice(0, MAX_SESSION_ITEMS)) {
    if (!isRecord(item)) continue;
    const kind = item.kind;
    if (typeof kind !== 'string' || !KINDS.has(kind as MeasurementKind)) continue;
    const k = kind as MeasurementKind;
    // Slice BEFORE filter/map so the cap bounds the WORK, not just the output —
    // a single measurement carrying tens of millions of points can't OOM the tab.
    const points = Array.isArray(item.points)
      ? item.points.slice(0, MAX_MEASUREMENT_POINTS).filter(isVec3).map((p): Vec3 => [p[0], p[1], p[2]])
      : [];
    if (points.length < MIN_POINTS[k]) continue;
    const m: Measurement = {
      id: typeof item.id === 'string' ? item.id : freshMeasurementId(),
      kind: k,
      name: typeof item.name === 'string' ? item.name : k,
      points,
      closed: item.closed === true ? true : undefined,
    };
    // v6 — the per-measurement honesty grade travels with the measurement so a
    // shared Evidence Capsule keeps its red/yellow/green verdict + reasons, not
    // just the number. The recipient sees the AUTHOR's trust assessment (what
    // was actually found), which is the point of evidence.
    const trust = parseMeasurementTrust(item.trust);
    if (trust) m.trust = trust;
    // v8. Which layer this measurement belongs to, and which frame its stored
    // vertices are already in. A malformed claim leaves the field undefined:
    // the measurement is kept, and the ownership migration attributes it the
    // same way it attributes legacy work, marked inferred rather than asserted.
    const owner = parseWorkOwnership(item.owner);
    if (owner) m.owner = owner;
    // Kind-specific specialised data. Serialised as part of the Measurement
    // object; parsed here so a round-tripped profile/volume keeps its chart,
    // corridor width, ground percentile, cut/fill record, and resident-only
    // provenance instead of degrading to bare vertices. Each field is validated
    // and gated on its kind; anything malformed is dropped, never thrown.
    if (k === 'profile') {
      const chart = parseProfileChart(item.profileChart);
      if (chart) m.profileChart = chart;
      if (item.profileChartResidentOnly === true) m.profileChartResidentOnly = true;
      if (isFiniteNum(item.profileCorridorWidth)) m.profileCorridorWidth = item.profileCorridorWidth;
      if (isFiniteNum(item.profileGroundPercentile)) {
        // Percentile is dimensionless 0..100; clamp defensively.
        m.profileGroundPercentile = Math.min(100, Math.max(0, item.profileGroundPercentile));
      }
      // Additive within v8 — the sample's provenance record (sources by stable
      // layer id, classification kind, class policy, coverage, units). Absent
      // in every session written before it existed, and read through the
      // record's own tolerant parser, so a malformed one drops the record and
      // keeps the measurement.
      const provenance = parseProfileProvenance(item.profileProvenance);
      if (provenance) m.profileProvenance = provenance;
    } else if (k === 'volume') {
      const volume = parseVolumeRecord(item.volume);
      if (volume) m.volume = volume;
      if (item.volumeResidentOnly === true) m.volumeResidentOnly = true;
    }
    out.push(m);
  }
  return out;
}

/** A finite number, else the value is treated as absent. */
function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Parse a persisted profile height-vs-distance series, or `undefined` when it
 * isn't a usable array. Each sample needs finite `distance`; `height` may be
 * NaN (a corridor gap) so it's accepted as any number, and the raw JSON encodes
 * NaN as `null`, which we map back to NaN. `count` is optional and finite.
 */
function parseProfileChart(v: unknown): ProfileChartSample[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: ProfileChartSample[] = [];
  for (const s of v.slice(0, MAX_SESSION_ITEMS)) {
    if (!isRecord(s)) continue;
    if (!isFiniteNum(s.distance)) continue;
    // JSON has no NaN literal — a gap serialises as null; restore it to NaN.
    const height = isFiniteNum(s.height) ? s.height : Number.NaN;
    const sample: ProfileChartSample = { distance: s.distance, height };
    if (isFiniteNum(s.count)) sample.count = s.count;
    out.push(sample);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Record version this reader understands, mirroring
 * `PROFILE_PROVENANCE_VERSION` in `render/measure/profileProvenance.ts`.
 *
 * Mirrored rather than imported: the io layer takes no RUNTIME dependency on
 * the render layer (`lint:module-graph` holds that coupling shrink-only), and
 * the two are pinned equal by a test rather than by an import.
 */
const PROFILE_PROVENANCE_RECORD_VERSION = 1;

/** Sources one persisted provenance record may carry. Untrusted-input ceiling. */
export const MAX_PROVENANCE_SOURCES = 4096;

const PROVENANCE_CLASS_KINDS: ReadonlySet<string> = new Set(['producer', 'derived', 'absent']);
const PROVENANCE_SCOPES: ReadonlySet<string> = new Set([
  'full-static-source',
  'mixed-full-and-resident',
  'resident-snapshot',
  'empty',
]);
const PROVENANCE_LINEAR_UNITS: ReadonlySet<string> = new Set([
  'metre',
  'foot',
  'us-survey-foot',
  'unknown',
]);
const PROVENANCE_VERTICAL_REFERENCES: ReadonlySet<string> = new Set([
  'ellipsoidal',
  'orthometric',
  'depth',
  'local',
  'unknown',
]);

/**
 * Parse a persisted profile provenance record, or `undefined` when it is not
 * usable — additive within v8, so a session that predates it simply has none.
 *
 * Tolerant on the same terms as the chart and volume readers above: anything
 * malformed drops the RECORD and keeps the measurement, because a profile
 * without provenance is still a profile, while a half-read provenance record
 * is a claim nobody made. A record from a LATER version is dropped for the
 * same reason: a reader that does not know what changed cannot vouch for it.
 *
 * The shape is `ProfileProvenance` by declaration, so a field added or renamed
 * in that module fails to compile here rather than silently going unread.
 */
function parseProfileProvenance(v: unknown): ProfileProvenance | undefined {
  if (!isRecord(v)) return undefined;
  if (v.recordVersion !== PROFILE_PROVENANCE_RECORD_VERSION) return undefined;
  if (typeof v.capturedAt !== 'string') return undefined;
  if (typeof v.method !== 'string' || v.method === '') return undefined;
  if (!isFiniteNum(v.corridorVersion)) return undefined;
  const up = parseProvenanceUp(v.up);
  if (!up) return undefined;
  if (!Array.isArray(v.sources)) return undefined;
  const units = parseProvenanceUnits(v.units);
  if (!units) return undefined;
  const policy = isRecord(v.classPolicy) ? v.classPolicy : null;
  // The availability flag is load-bearing: absent, the record would read as
  // "classification everywhere" by omission, which is the one thing it exists
  // to stop. No default is honest, so the record is refused instead.
  if (!policy || typeof policy.availableOnEverySource !== 'boolean') return undefined;
  const sources: Array<ProfileProvenance['sources'][number]> = [];
  for (const raw of v.sources.slice(0, MAX_PROVENANCE_SOURCES)) {
    if (!isRecord(raw)) continue;
    // Identity is the stable layer id. A row without one names no layer, and a
    // display name would not stand in for it: it is renameable.
    if (typeof raw.layerId !== 'string' || raw.layerId === '') continue;
    if (typeof raw.classification !== 'string') continue;
    if (!PROVENANCE_CLASS_KINDS.has(raw.classification)) continue;
    if (!isFiniteNum(raw.acceptedCount) || raw.acceptedCount < 0) continue;
    sources.push({
      layerId: raw.layerId,
      displayName: typeof raw.displayName === 'string' ? raw.displayName : '',
      classification: raw.classification as ProfileClassificationKind,
      streaming: raw.streaming === true,
      acceptedCount: raw.acceptedCount,
      contributed: raw.contributed === true,
      // Unknown residency is null, never false: see `streamingIsComplete`.
      residency: raw.residency === true ? true : raw.residency === false ? false : null,
    });
  }
  return {
    recordVersion: PROFILE_PROVENANCE_RECORD_VERSION,
    method: v.method,
    corridorVersion: v.corridorVersion,
    capturedAt: v.capturedAt,
    up,
    upDegenerate: v.upDegenerate === true,
    sources,
    acceptedCount: isFiniteNum(v.acceptedCount) && v.acceptedCount >= 0 ? v.acceptedCount : 0,
    scope:
      typeof v.scope === 'string' && PROVENANCE_SCOPES.has(v.scope)
        ? (v.scope as ProfileSectionScope)
        : 'empty',
    residentOnly: v.residentOnly === true,
    // Same rule as residency, one level up: only an explicit boolean is a claim.
    complete: v.complete === true ? true : v.complete === false ? false : null,
    classPolicy: {
      excludedClasses: sanitizeClassFilter(policy.excludedClasses),
      availableOnEverySource: policy.availableOnEverySource,
    },
    units,
  };
}

/** Three finite components, else the record is not usable. */
function parseProvenanceUp(v: unknown): [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  if (!v.every(isFiniteNum)) return undefined;
  return [v[0] as number, v[1] as number, v[2] as number];
}

/**
 * The unit context, falling back to `unknown` per field rather than to a
 * default unit. An unreadable linear unit is not metres.
 */
function parseProvenanceUnits(v: unknown): ProfileUnitContext | undefined {
  if (!isRecord(v)) return undefined;
  return {
    linearUnit:
      typeof v.linearUnit === 'string' && PROVENANCE_LINEAR_UNITS.has(v.linearUnit)
        ? (v.linearUnit as ProfileUnitContext['linearUnit'])
        : 'unknown',
    verticalReference:
      typeof v.verticalReference === 'string' &&
      PROVENANCE_VERTICAL_REFERENCES.has(v.verticalReference)
        ? (v.verticalReference as ProfileUnitContext['verticalReference'])
        : 'unknown',
    verticalMetresPerUnit: isFiniteNum(v.verticalMetresPerUnit) ? v.verticalMetresPerUnit : null,
  };
}

const VOLUME_CONFIDENCE: ReadonlySet<VolumeRecord['confidence']> = new Set(['high', 'medium', 'low']);

/**
 * Parse a persisted volume cut/fill record, or `undefined` when malformed. All
 * numeric fields must be finite; an unknown confidence band is dropped so the
 * record can't carry an invalid badge. Values are stored in native render
 * units³ (see the VolumeRecord unit contract) and are not converted here.
 */
function parseVolumeRecord(v: unknown): VolumeRecord | undefined {
  if (!isRecord(v)) return undefined;
  const nums = ['fill', 'cut', 'net', 'referenceZ', 'footprintArea', 'pointsInPolygon'] as const;
  for (const key of nums) if (!isFiniteNum(v[key])) return undefined;
  // The field was renamed `density` → `densityNative` to stop calling a native
  // horizontal-unit² figure "points/m²". Older files carry `density`, which held
  // exactly the same native value, so migrating it across is lossless.
  let densityNative: number | undefined;
  if (isFiniteNum(v.densityNative)) {
    densityNative = v.densityNative;
  } else if (isFiniteNum(v.density)) {
    densityNative = v.density;
  } else {
    densityNative = undefined;
  }
  if (densityNative === undefined) return undefined;
  if (typeof v.confidence !== 'string'
    || !VOLUME_CONFIDENCE.has(v.confidence as VolumeRecord['confidence'])) {
    return undefined;
  }
  const record: VolumeRecord = {
    fill: v.fill as number,
    cut: v.cut as number,
    net: v.net as number,
    referenceZ: v.referenceZ as number,
    footprintArea: v.footprintArea as number,
    pointsInPolygon: v.pointsInPolygon as number,
    densityNative,
    confidence: v.confidence as VolumeRecord['confidence'],
  };
  // Optional partial-coverage disclosure (points inside the footprint the
  // integration had to skip). Round-trips when present; older files omit it.
  if (isFiniteNum(v.skippedNonFinite) && v.skippedNonFinite > 0) {
    record.skippedNonFinite = v.skippedNonFinite;
  }
  return record;
}

const TRUST_GRADES: ReadonlySet<TrustGrade> = new Set(['green', 'yellow', 'red']);

/** Defensively parse a persisted measurement trust grade; null if malformed. */
function parseMeasurementTrust(v: unknown): MeasurementTrust | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.grade !== 'string' || !TRUST_GRADES.has(v.grade as TrustGrade)) return undefined;
  if (typeof v.caption !== 'string') return undefined;
  if (typeof v.presentable !== 'boolean') return undefined;
  const reasons = Array.isArray(v.reasons)
    ? v.reasons.filter((r): r is string => typeof r === 'string')
    : [];
  return {
    grade: v.grade as TrustGrade,
    caption: v.caption,
    reasons,
    presentable: v.presentable,
  };
}

function parseAnnotations(v: unknown): Annotation[] {
  if (!Array.isArray(v)) return [];
  const out: Annotation[] = [];
  for (const item of v.slice(0, MAX_SESSION_ITEMS)) {
    if (!isRecord(item)) continue;
    // An annotation with no valid position is meaningless — drop it.
    const local = parseVec3Object(item.localPosition);
    if (!local) continue;

    const created = isFiniteNumber(item.createdAt) ? item.createdAt : Date.now();
    const updated = isFiniteNumber(item.updatedAt) ? item.updatedAt : created;
    const annotation: Annotation = {
      id: typeof item.id === 'string' && item.id.length > 0 ? item.id : freshAnnotationId(),
      // Cap the length — a title is a label, not a payload; a multi-MB string is abuse.
      title:
        typeof item.title === 'string' && item.title.length > 0
          ? item.title.slice(0, MAX_ANNOTATION_TITLE)
          : 'Annotation',
      type: isAnnotationType(item.type) ? item.type : 'note',
      createdAt: created,
      updatedAt: updated,
      localPosition: local,
    };
    if (typeof item.note === 'string' && item.note.length > 0) {
      annotation.note = item.note.slice(0, MAX_ANNOTATION_NOTE);
    }
    const world = parseVec3Object(item.worldPosition);
    if (world) annotation.worldPosition = world;
    // The owning layer + CRS label — the world frame's provenance, kept so a
    // report can attribute the annotation and name the survey frame on reload.
    if (typeof item.layerId === 'string' && item.layerId.length > 0) {
      annotation.layerId = item.layerId;
    }
    if (typeof item.crs === 'string' && item.crs.length > 0) annotation.crs = item.crs;
    // v8. The owning layer's STABLE id plus the frame the stored position is
    // in. Distinct from `layerId` above, which holds the cloud's display name
    // for report attribution and is not an identity. Malformed ⇒ left
    // undefined, and the migration marks what it assigns as inferred.
    const owner = parseWorkOwnership(item.owner);
    if (owner) annotation.owner = owner;
    if (isRecord(item.cameraState)) annotation.cameraState = parseCameraState(item.cameraState);
    if (typeof item.linkedMeasurementId === 'string') {
      annotation.linkedMeasurementId = item.linkedMeasurementId;
    }
    // The inspection workflow (severity, open/resolved status, observation
    // date). Additive and OPTIONAL, so it is read version-independently like
    // `layerId` above: a file that carries the block gets it back whatever
    // version it declares, and a file without one yields a plain annotation.
    // Malformed contents degrade inside `parseIssueDetails` rather than
    // failing the import; a block that is not an object is treated as absent.
    const issue = parseIssueDetails(item.issue);
    if (issue) annotation.issue = issue;
    out.push(annotation);
  }
  return out;
}

/**
 * A unique measurement id — `crypto.randomUUID`, else random bytes.
 *
 * Only reached for a session whose stored measurement has no id. `randomUUID`
 * needs a secure context; `getRandomValues` does not, so a viewer served over
 * plain http still mints ids that cannot collide with another tab's.
 */
function freshMeasurementId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint32Array(2);
  c.getRandomValues(bytes);
  return `m_${bytes[0].toString(36).padStart(7, '0')}${bytes[1].toString(36).padStart(7, '0')}`;
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
/** A finite, ordered inclusive `[min, max]` window, or null when malformed. */
function parseWindow(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = v[0];
  const b = v[1];
  if (!isFiniteNumber(a) || !isFiniteNumber(b)) return null;
  return a <= b ? [a, b] : [b, a];
}

/**
 * Validate the optional point-filter block, keeping only the windows that
 * parse. Returns null when neither is usable so the field is omitted entirely
 * (an unfiltered session keeps its pre-v6 byte-shape).
 */
function sanitizePointFilters(v: unknown): SessionPointFilters | null {
  if (!isRecord(v)) return null;
  const elevation = parseWindow(v.elevation);
  const intensity = parseWindow(v.intensity);
  if (!elevation && !intensity) return null;
  const out: SessionPointFilters = {};
  if (elevation) out.elevation = elevation;
  if (intensity) out.intensity = intensity;
  return out;
}

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
    // Defense in depth: clamp on parse to the same [1, 8] range the Viewer and
    // preferences enforce, so a hand-edited / corrupt session can't carry a
    // pathological size even before it reaches setPointSize.
    pointSize: isFiniteNumber(v.pointSize) ? Math.min(8, Math.max(1, v.pointSize)) : 1.5,
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
  if (isFiniteNumber(v.epsg)) out.epsg = v.epsg;
  if (typeof v.crsUnit === 'string' && v.crsUnit.length > 0) out.crsUnit = v.crsUnit;
  return out;
}

// The resolved-CRS parser lives in `./sessionCrs` so the session document and
// the v8 project-frame records validate a persisted CRS through one definition.
