/**
 * sessionSnapshot.ts — the live session as `.olvsession` JSON.
 *
 * One writer for both Save session and the recovery journal, so the two can
 * never record different sessions. Loaded lazily; `main.ts` binds its running
 * state through {@link SessionSnapshotDeps}. The provenance builders are
 * optional: the recovery journal loads them only after an analysis exists.
 */
import type { Viewer } from '../render/Viewer';
import type { PointCloud } from '../model/PointCloud';
import type { ViewStateBundle } from '../io/viewState';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { SessionLayerGroup, SessionScanSummary } from '../io/session';
import type { AnalyseContoursResult } from '../terrain/contour/analyseContours';
import type { StoredView } from './appContext';
import type { WorkplaneSettings } from '../model/workplaneSettings';
import { isZUpFormat } from '../io/sniffFormat';
import { resolveLayerUpFrame } from '../geo/frame/layerUpFrame';
import { TERRAIN_METRIC_VERSION } from '../terrain/datasetIntelligence';
import { partitionSessionWork, type OwnershipView } from './measurementOwnership';
import { buildSessionProjectFrame, carryHeldSessionWork, type HeldSessionWork, type SessionFrameInput, type SessionProjectFrame } from '../io/sessionFrame';

export type SessionWriterModules = typeof import('../io/session') &
  Partial<typeof import('../terrain/export/exportProvenance')>;

export interface SessionSnapshotDeps {
  getViewer(): Viewer;
  activeCloud(): PointCloud | null;
  /** The current analysis result, or null when none exists. */
  analysedResult(): AnalyseContoursResult | null;
  verticalUnitToMetres(): number | null;
  captureViewState(): ViewStateBundle;
  savedViews(): readonly StoredView[];
  /** The scene frame origin (static cloud origin, else the streaming renderOrigin). */
  origin(): readonly [number, number, number];
  crs(): ResolvedCrs | null | undefined;
  layerGroups(): SessionLayerGroup[];
  /** The reference plane's settings, or undefined when it was never used. */
  referencePlane?(): WorkplaneSettings | undefined;
  /**
   * The live project frame when two or more static layers share one, or the
   * one open layer is still placed in it: its origin and every layer's record
   * input. Null for a single unplaced scan, a streaming scene, or a layer with
   * no proven identity, where the single-origin reading applies exactly as before.
   * `force` asks for a frame of one for a lone layer in its own frame, so held
   * work has records to be read back through.
   */
  projectFrame?(force?: boolean): SessionFrameInput | null;
  /**
   * Work a session import could not place because its scan is not open (or is
   * open more than once). Written back with the records it is read through.
   */
  heldWork?(): HeldSessionWork | null;
  /** SHA-256 of the active scan's source bytes, when already computed. */
  sourceSha256?(): string | null;
  /**
   * The open layers, for checking that saved work belongs to the scan being
   * saved. Absent: every item is written as recorded.
   */
  ownershipView?(): OwnershipView;
  /** Told when work was left out of the file, with the reason. */
  onWithheld?(message: string): void;
  readonly appVersion: string;
}

/**
 * The frame block to write, or undefined when there is none or it cannot be
 * built consistently. A frame that will not build is left out rather than
 * written wrong; the origin it would have named is still what `origin()` returns.
 * One layer writes a frame only while it is placed in it: an unplaced lone
 * scan keeps the single-origin byte shape.
 */
function liveProjectFrame(deps: SessionSnapshotDeps, force = false): SessionProjectFrame | undefined {
  const input = deps.projectFrame?.(force) ?? null;
  if (!input || input.layers.length === 0 || (!force && input.layers.length === 1 && !input.layers[0]!.placed)) return undefined;
  try {
    return buildSessionProjectFrame(input);
  } catch {
    return undefined;
  }
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function serializeActiveSession(
  { serializeSession, buildExportProvenance, processingManifestFromProvenance }: SessionWriterModules,
  deps: SessionSnapshotDeps,
): string {
  const viewer = deps.getViewer();
  const cloud = deps.activeCloud() ?? undefined;
  // Streaming-only: no static cloud, but COPC/EPT are LAS-derived (Z-up) with a
  // renderOrigin frame; [0,0,0] + Y-up reopened the session displaced and mis-oriented.
  const upAxis: 'y' | 'z' = cloud ? (isZUpFormat(cloud.sourceFormat) ? 'z' : 'y') : viewer.streamingCloud ? 'z' : 'y';
  // `upAxis` stays the format's axis, which reopening matches scans on. The
  // RESOLVED axis and its basis (a PLY under a CRS is Z-up) are recorded beside it.
  const resolvedUp = cloud?.sourceFormat ? resolveLayerUpFrame({ format: cloud.sourceFormat, crs: deps.crs() }) : null;
  const upFrame = resolvedUp ? { axis: resolvedUp.ok ? resolvedUp.axis : resolvedUp.drawAxis, basis: resolvedUp.basis } : undefined;

  // v3 fields capture the full working state; optional fields are emitted only when meaningful.
  const streamingCloud = viewer.streamingCloud;
  const exportFileName = streamingCloud?.name ?? (cloud ? cloud.name : null);

  let scanSummary: SessionScanSummary | undefined;
  if (streamingCloud && streamingCloud.sourcePointCount !== null) {
    // Tight data AABB, not the octree cube. No summary without a source total.
    const b = streamingCloud.dataBounds();
    const crs = streamingCloud.crs();
    scanSummary = {
      fileName: streamingCloud.name,
      sourcePoints: streamingCloud.sourcePointCount,
      width: b[3] - b[0],
      depth: b[4] - b[1],
      height: b[5] - b[2],
      ...(crs ? { crs: crs.name, crsUnit: crs.linearUnit, ...(crs.epsg != null ? { epsg: crs.epsg } : {}) } : {}),
    };
  } else if (cloud) {
    const b = cloud.bounds();
    const crs = cloud.metadata?.crs;
    scanSummary = {
      fileName: cloud.name,
      sourcePoints: cloud.declaredPointCount ?? cloud.decodedPointCount ?? cloud.pointCount,
      width: b.max[0] - b.min[0],
      depth: b.max[1] - b.min[1],
      height: b.max[2] - b.min[2],
      ...(crs ? { crs: crs.name, crsUnit: crs.linearUnit, ...(crs.epsg != null ? { epsg: crs.epsg } : {}) } : {}),
      boundsMin: [cloud.sourceOrigin[0] + b.min[0], cloud.sourceOrigin[1] + b.min[1], cloud.sourceOrigin[2] + b.min[2]],
      ...(deps.sourceSha256?.() ? { sha256: deps.sourceSha256()! } : {}),
    };
  }

  // v7 — the verify-only processing manifest, filled into the slot the schema
  // reserved. Derived from the CURRENT analysis result's provenance (the same
  // derivation every terrain export stamps), so a session saved after an
  // analysis carries the ordered, hash-chained record of the methods + final
  // parameters behind the on-screen numbers. No analysis (or no scan yet) → the
  // slot stays absent (serializeSession omits it), never an empty placeholder.
  let processingManifest: unknown;
  const analysed = deps.analysedResult();
  if (analysed && buildExportProvenance && processingManifestFromProvenance) {
    processingManifest = processingManifestFromProvenance(
      buildExportProvenance(analysed, {
        basename: exportFileName ? baseName(exportFileName) : null,
        generatedAt: new Date(), verticalUnitToMetres: deps.verticalUnitToMetres(),
        softwareVersion: deps.appVersion,
        metricVersion: TERRAIN_METRIC_VERSION,
      }), cloud?.organizedRange);
  }

  // The GLOBAL live state and every saved view's bundle come from the same
  // capture path (captureViewState) — the extraction that replaced the old
  // inline field-by-field block here, so the export and the named views can
  // never record different notions of "the current state". Field-level
  // rationale (the v5 clip write-side fix, the hidden-codes contract, the
  // emit-only-when-set discipline) lives on captureViewState itself.
  const viewState = deps.captureViewState();
  // Work taken on a scan that is no longer open is never written under this
  // scan's name, origin and frame: it is left out, and the reason is given.
  const view = deps.ownershipView?.();
  const m = view ? partitionSessionWork(viewer.measure.getMeasurements(), view) : { keep: viewer.measure.getMeasurements(), leftOut: 0 };
  const a = view ? partitionSessionWork(viewer.annotate.getAnnotations(), view) : { keep: viewer.annotate.getAnnotations(), leftOut: 0 };
  if (m.leftOut + a.leftOut > 0) {
    const n = m.leftOut + a.leftOut;
    deps.onWithheld?.(`${n} measurement${n === 1 ? '' : 's'} or annotation${n === 1 ? '' : 's'} left out of the session: taken on a scan that is no longer open, so there is no frame to save ${n === 1 ? 'it' : 'them'} in.`);
  }
  // Held work goes back into the file with the records it is read through,
  // moved into this file's frame without moving in the world. With no frame to
  // write it in (no layer with a proven identity) it cannot be written, and
  // the user is told rather than it vanishing.
  const held = deps.heldWork?.() ?? null;
  let projectFrame = liveProjectFrame(deps, held !== null);
  let measurements = m.keep;
  let annotations = a.keep;
  if (held) {
    if (projectFrame) {
      const carried = carryHeldSessionWork(projectFrame, held);
      projectFrame = carried.frame;
      measurements = [...measurements, ...carried.measurements];
      annotations = [...annotations, ...carried.annotations];
    } else {
      const n = held.measurements.length + held.annotations.length;
      deps.onWithheld?.(`${n} restored item${n === 1 ? '' : 's'} waiting for ${n === 1 ? 'its scan' : 'their scans'} left out of the session: no open scan has a proven identity to record ${n === 1 ? 'it' : 'them'} against.`);
    }
  }
  return serializeSession({
    upAxis,
    ...(upFrame ? { upFrame } : {}),
    // The frame every saved coordinate is local to. With two or more scans, or
    // one still placed in the project frame, that is the project frame, and
    // the origin comes from the frame block itself so the two can never
    // disagree. Otherwise it is the scene's single frame: the static cloud's
    // origin, else the streaming renderOrigin, else zero.
    origin: projectFrame ? [...projectFrame.projectOrigin] : [...deps.origin()],
    ...(projectFrame ? { projectFrame } : {}),
    unitSystem: viewer.measure.unitSystem,
    // v7 — a view with a captured bundle serialises it per-view; a camera-only
    // view (e.g. restored from a v6 file) spreads nothing and keeps its exact
    // v6 byte-shape.
    views: deps.savedViews().map((v) => ({ name: v.name, camera: v.pose, ...(v.state ?? {}) })),
    measurements,
    annotations,
    camera: viewState.camera,
    render: viewState.render,
    colorMode: viewState.colorMode,
    scanSummary,
    classFilter: viewState.classFilter,
    ...(viewState.pointFilters ? { pointFilters: viewState.pointFilters } : {}),
    clip: viewState.clip,
    // v6 — stamp the producing app version so a later re-open can tell whether a
    // newer build would read the scan differently (see exportStaleness).
    software: deps.appVersion,
    // v7 — the reserved slot, filled above when an analysis exists; the
    // serializer omits it when undefined so no-analysis sessions keep their
    // byte-shape.
    processingManifest,
    // The active scan's RESOLVED CRS (detection + any user override), so the
    // choice round-trips and a re-open does not silently re-prompt or revert
    // to the file's declared CRS (C4). The v4 schema already carries this
    // field; the exporter simply never populated it.
    crs: deps.crs() ?? undefined,
    layerGroups: deps.layerGroups(),
    referencePlane: deps.referencePlane?.(),
  });
}
