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
import { isZUpFormat } from '../io/sniffFormat';
import { TERRAIN_METRIC_VERSION } from '../terrain/datasetIntelligence';

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
  readonly appVersion: string;
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
  return serializeSession({
    upAxis,
    // The scene's real frame, static OR streaming — exportGeoContext resolves the
    // static cloud's origin, else the streaming renderOrigin, else zero.
    origin: [...deps.origin()],
    unitSystem: viewer.measure.unitSystem,
    // v7 — a view with a captured bundle serialises it per-view; a camera-only
    // view (e.g. restored from a v6 file) spreads nothing and keeps its exact
    // v6 byte-shape.
    views: deps.savedViews().map((v) => ({ name: v.name, camera: v.pose, ...(v.state ?? {}) })),
    measurements: viewer.measure.getMeasurements(),
    annotations: viewer.annotate.getAnnotations(),
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
  });
}
