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
import type { MeasurementTrust, TrustGrade } from '../render/measure/measurementTrust';
import type { Annotation, SavedCameraState, Vec3Object } from '../render/annotate/types';
import { freshAnnotationId, isAnnotationType } from '../render/annotate/types';
import type { ColorMode } from '../render/colorModes';
import type { PointSizeMode } from '../render/pointStyle';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { BoxBounds } from '../render/measure/geometry';
import type { ClipBox, ClipMode } from '../render/clip/clipBox';

/**
 * Current session-file schema version (v7). The history, oldest first: v3 added
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
 * Older v1 + v2 files parse with no loss — the new optional fields just
 * read as undefined, and the Viewer falls back to its current state.
 */
export const SESSION_VERSION = 7;

/** Schema versions `parseSession` can read. */
const SUPPORTED_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

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
}

const KINDS: readonly MeasurementKind[] = [
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
];

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
  return JSON.stringify(doc, null, 2);
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
  if (raw.processingManifest != null) out.processingManifest = raw.processingManifest;
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

  const measurements = session.measurements.map((m) => {
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
    const next: Annotation = {
      ...a,
      localPosition: {
        x: a.localPosition.x + dx,
        y: a.localPosition.y + dy,
        z: a.localPosition.z + dz,
      },
      // Drop the cached world position — it was derived against the OLD frame and
      // the viewer recomputes it from the rebased local plus the active origin.
      worldPosition: undefined,
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
  v.forEach((item, i) => {
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

/** Hard cap on parsed list lengths — a hostile/corrupt file can't hang the tab. */
const MAX_SESSION_ITEMS = 100_000;

function parseMeasurements(v: unknown): Measurement[] {
  if (!Array.isArray(v)) return [];
  const out: Measurement[] = [];
  for (const item of v.slice(0, MAX_SESSION_ITEMS)) {
    if (!isRecord(item)) continue;
    const kind = item.kind;
    if (typeof kind !== 'string' || !KINDS.includes(kind as MeasurementKind)) continue;
    const k = kind as MeasurementKind;
    const points = Array.isArray(item.points)
      ? item.points.filter(isVec3).map((p): Vec3 => [p[0], p[1], p[2]])
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
    const height = isFiniteNum(s.height) ? s.height : NaN;
    const sample: ProfileChartSample = { distance: s.distance, height };
    if (isFiniteNum(s.count)) sample.count = s.count;
    out.push(sample);
  }
  return out.length > 0 ? out : undefined;
}

const VOLUME_CONFIDENCE: readonly VolumeRecord['confidence'][] = ['high', 'medium', 'low'];

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
  const densityNative = isFiniteNum(v.densityNative)
    ? v.densityNative
    : isFiniteNum(v.density)
      ? v.density
      : undefined;
  if (densityNative === undefined) return undefined;
  if (typeof v.confidence !== 'string'
    || !VOLUME_CONFIDENCE.includes(v.confidence as VolumeRecord['confidence'])) {
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

const TRUST_GRADES: readonly TrustGrade[] = ['green', 'yellow', 'red'];

/** Defensively parse a persisted measurement trust grade; null if malformed. */
function parseMeasurementTrust(v: unknown): MeasurementTrust | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.grade !== 'string' || !TRUST_GRADES.includes(v.grade as TrustGrade)) return undefined;
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
    // The vertical + datum fields. The serializer has always written the whole
    // ResolvedCrs; only these were dropped on the way back in, so a
    // compound-CRS session reopened with its geometry intact and the metadata
    // needed to interpret its heights silently gone.
    ...(isFiniteNumber(v.verticalEpsg) ? { verticalEpsg: v.verticalEpsg } : {}),
    ...(typeof v.verticalDatum === 'string' && v.verticalDatum.length > 0
      ? { verticalDatum: v.verticalDatum }
      : {}),
    ...(isFiniteNumber(v.verticalUnitToMetres) && v.verticalUnitToMetres > 0
      ? { verticalUnitToMetres: v.verticalUnitToMetres }
      : {}),
    ...(typeof v.horizontalDatum === 'string' && v.horizontalDatum.length > 0
      ? { horizontalDatum: v.horizontalDatum }
      : {}),
  };
  return out;
}
