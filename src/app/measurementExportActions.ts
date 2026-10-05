/**
 * measurementExportActions.ts
 *
 * The two measurement-deliverable exports the Export panel drives — the open
 * GeoJSON/CSV file and the signed integrity report — lifted out of the
 * composition root so `main.ts` wires them in one line each. Both read the live
 * measure state and the resolved export frame at one instant, build the shared
 * export context (unit / up-axis / verified-scale aware), and hand off to the
 * pure serializers. Kept as free functions over an explicit deps object so the
 * orchestration is testable without the whole app.
 */

import type { Measurement, Vec3 } from '../render/measure/types';
import type { MeasurementExportContext } from '../export/measurementExport';
import type { ReportFinding } from '../render/measure/reportManifest';
import type { GeoExportContext } from './reportExport';

import type { ActiveScanBasis } from './measurementScanHooks';

export type { ActiveScanBasis } from './measurementScanHooks';

/** The slice of the measure controller these exports read. */
export interface MeasureExportView {
  getMeasurements(): readonly Measurement[];
  readonly worldUp: Vec3;
  readonly unitToMetres: number;
  readonly verticalUnitToMetres: number;
  /** True when the scan's linear scale is known — drives the M1 units caveat. */
  readonly crsKnown: boolean;
  /**
   * True when the horizontal frame is ANGULAR (lon/lat degrees).
   *
   * The controller has always tracked this and grades measurements on it, but
   * the export view did not expose it, so the export hardcoded `false`. Two
   * things went wrong from that: the GeoJSON kept a named CRS member it should
   * have suppressed, and a degree difference was carried into the metre-named
   * columns by a scalar factor that cannot exist for an angular frame.
   */
  readonly geographicCrs: boolean;
}

export interface MeasurementExportActionDeps {
  readonly measure: MeasureExportView;
  /** Resolved export frame (origin + resolved CRS label + name), read once. */
  readonly geo: () => GeoExportContext;
  readonly baseName: (name: string) => string;
  readonly downloadText: (filename: string, text: string) => void;
  readonly loadMeasurementExport: () => Promise<
    Pick<typeof import('../export/measurementExport'), 'measurementsToGeoJSON' | 'measurementsToCsv' | 'measurementCsvProvenance' | 'provenanceSidecarName' | 'resolveExportDigests'>
  >;
  readonly loadMeasurementReport: () => Promise<
    Pick<
      typeof import('../export/measurementReport'),
      'integrityReportFile' | 'measurementsToFindings' | 'findingsReportFile' | 'resolveExportDigests'
    >
  >;
  /**
   * Every open layer, for placing each measurement through the layer it was
   * taken on. Omitted or a single layer: the active frame from `geo()`.
   */
  readonly layers?: { readonly view: ExportLayerView; readonly stableIdFor: (viewerId: string) => string | null };
  /** Shown when the export is refused rather than written. */
  readonly refuse?: (message: string) => void;
  /** Shown after a write, on the app's toast line. */
  readonly notify?: (message: string) => void;
  /** Active scan's classification epoch (0 when none), for the report manifest. */
  readonly activeClassificationEpoch: () => number;
  /**
   * The active scan's point basis line and class-edit state, for the CSV's
   * provenance sidecar; null when no scan is active.
   */
  readonly activeScanBasis?: () => ActiveScanBasis | null;
  readonly appVersion: string;
  /** ISO timestamp source — injected so the report build stays deterministic. */
  readonly now: () => string;
}

/** One open layer, as the measurement export places points through it. */
export interface ExportLayer {
  /** Stable layer id (`model/layerIdentity`), or null when none was bound. */
  readonly stableId: string | null;
  /** Display name: the file name. */
  readonly name: string;
  readonly sourceOrigin: readonly [number, number, number];
  /** source-local to project-local offset, or null when the layer is unplaced. */
  readonly projectOffset: readonly [number, number, number] | null;
  /** The CRS the layer's file declares, or null. */
  readonly crsName: string | null;
}

/** The slice of the viewer the layer read needs. */
export interface ExportLayerView {
  clouds(): readonly string[];
  getCloud(id: string): { readonly name: string; readonly sourceOrigin: readonly [number, number, number]; readonly metadata?: { readonly crs?: { readonly name?: string } | null } | null } | undefined;
  layerProjectOffset(id: string): readonly [number, number, number] | null;
}

/** The open layers of a viewer, read once for an export. */
export function exportLayersOf(v: ExportLayerView, stableIdFor: (viewerId: string) => string | null): ExportLayer[] {
  const out: ExportLayer[] = [];
  for (const id of v.clouds()) {
    const c = v.getCloud(id);
    if (!c) continue;
    out.push({ stableId: stableIdFor(id), name: c.name, sourceOrigin: c.sourceOrigin, projectOffset: v.layerProjectOffset(id), crsName: c.metadata?.crs?.name ?? null });
  }
  return out;
}

/** Where one measurement's points leave: the world offset to add, and its scans. */
interface Placed {
  readonly base: readonly [number, number, number];
  readonly names: readonly string[];
}

/**
 * With several layers open, each measurement is placed through the layers its
 * points were picked on, or through its owner when no pick was recorded (a
 * restored or programmatic measurement). A point leaves as the point less its
 * layer's placement offset plus its file origin; a `source-local` owner's
 * points are already in that layer's frame. A measurement whose layer is
 * unknown, one whose points sit on layers that place it differently (heights
 * not in one frame, or an unmounted layer), or a set across different declared
 * CRSs has no single honest position, so the export is refused.
 */
function ownLayers(
  measurements: readonly Measurement[],
  layers: readonly ExportLayer[],
): { byId: Map<string, Placed> } | { refused: string } {
  const byId = new Map<string, Placed>();
  let unknown = 0;
  const split: string[] = [];
  const crs = new Set<string | null>();
  // A measurement with no recorded pick (restored, or placed without one) is
  // placed through its owner only when every open layer places a point the same
  // way; otherwise its layer would be a guess.
  const baseOf = (l: ExportLayer): number[] => l.sourceOrigin.map((o, i) => o - (l.projectOffset?.[i] ?? 0));
  const oneFrame = layers.every((l) => baseOf(l).every((c, i) => Math.abs(c - baseOf(layers[0]!)[i]!) <= 1e-6));
  for (const m of measurements) {
    const picked = m.pickLayers && m.pickLayers.length > 0;
    if (!picked && !oneFrame) {
      unknown++;
      continue;
    }
    const ids = picked ? m.pickLayers! : m.owner?.layerId ? [m.owner.layerId] : [];
    const ls = ids.map((id) => layers.find((x) => x.stableId === id));
    if (ls.length === 0 || ls.some((l) => !l)) {
      unknown++;
      continue;
    }
    const local = !picked && m.owner?.frame === 'source-local';
    const bases = (ls as ExportLayer[]).map((l): [number, number, number] => {
      const d = local ? [0, 0, 0] : l.projectOffset ?? [0, 0, 0];
      return [l.sourceOrigin[0] - d[0], l.sourceOrigin[1] - d[1], l.sourceOrigin[2] - d[2]];
    });
    if (bases.some((v) => v.some((c, i) => Math.abs(c - bases[0]![i]!) > 1e-6))) split.push(m.name);
    for (const l of ls) crs.add(l!.crsName);
    byId.set(m.id, { base: bases[0]!, names: [...new Set(ls.map((l) => l!.name))].sort((a, b) => a.localeCompare(b)) });
  }
  if (unknown > 0) {
    return { refused: `Not exported: ${unknown} of ${measurements.length} measurements have no record of the scan their points were picked on, so their coordinates cannot be placed. Close every scan but the one the measurements were taken on, then export again.` };
  }
  if (split.length > 0) {
    return { refused: `Not exported: ${split.join(', ')} has points on scans whose heights are not in one frame. Delete it or measure on one scan, then export again.` };
  }
  if (crs.size > 1) {
    return { refused: 'Not exported: the measurements come from scans with different coordinate systems. Export them one scan at a time.' };
  }
  return { byId };
}

/**
 * The measure state an export reads, copied at one instant. Taken before the
 * first await, so a scan swap or unit change while the serializer chunk loads
 * cannot pair one scan's geometry with another scan's scale or up axis.
 */
interface MeasureSnapshot {
  readonly measurements: readonly Measurement[];
  readonly worldUp: Vec3;
  readonly unitToMetres: number;
  readonly verticalUnitToMetres: number;
  readonly geographicCrs: boolean;
  /** Linear scale known and the frame not angular: the metre columns are real metres. */
  readonly unitsVerified: boolean;
}

function snapshotMeasure(measure: MeasureExportView): MeasureSnapshot {
  const measurements = measure.getMeasurements().map((m) => structuredClone(m));
  const w = measure.worldUp;
  return {
    measurements,
    worldUp: [w[0], w[1], w[2]],
    unitToMetres: measure.unitToMetres,
    verticalUnitToMetres: measure.verticalUnitToMetres,
    geographicCrs: measure.geographicCrs,
    unitsVerified: measure.crsKnown && !measure.geographicCrs,
  };
}

/**
 * Count the measurements that name a scan (by pick record or owner) that is no
 * longer open. Measurements survive closing their scan, so without this check
 * they would be placed through whichever scan is open now, under its name.
 */
function closedScanCount(measurements: readonly Measurement[], layers: readonly ExportLayer[]): number {
  const open = new Set(layers.map((l) => l.stableId).filter((id): id is string => id !== null));
  let n = 0;
  for (const m of measurements) {
    const ids = [...(m.pickLayers ?? []), ...(m.owner?.layerId ? [m.owner.layerId] : [])];
    if (ids.some((id) => !open.has(id))) n++;
  }
  return n;
}

/**
 * Refuse (and say why) when any measurement was taken on a scan that is no
 * longer open, or names a scan more than one open layer matches. True when
 * refused.
 */
function refusedForClosedScan(measurements: readonly Measurement[], deps: MeasurementExportActionDeps): boolean {
  const layers = deps.layers ? exportLayersOf(deps.layers.view, deps.layers.stableIdFor) : [];
  if (layers.length === 0) return false;
  // An owner id two open layers both carry names neither of them: placing the
  // measurement through the first match would be a guess.
  const held = new Map<string, number>();
  for (const l of layers) if (l.stableId !== null) held.set(l.stableId, (held.get(l.stableId) ?? 0) + 1);
  const shared = measurements.filter((m) => [...(m.pickLayers ?? []), ...(m.owner?.layerId ? [m.owner.layerId] : [])].some((id) => (held.get(id) ?? 0) > 1)).length;
  if (shared > 0) {
    deps.refuse?.(`Not exported: ${shared} ${shared === 1 ? 'measurement names' : 'measurements name'} a scan that more than one open scan matches. Close all but one of those scans, then export again.`);
    return true;
  }
  const closed = closedScanCount(measurements, layers);
  if (closed === 0) return false;
  deps.refuse?.(`Not exported: ${closed} ${closed === 1 ? 'measurement was' : 'measurements were'} taken on a scan that is no longer open. Reopen it or delete them, then export again.`);
  return true;
}

/** Export the placed measurements as an open GeoJSON or CSV file. */
export async function exportMeasurementsFile(
  format: 'geojson' | 'csv',
  deps: MeasurementExportActionDeps,
): Promise<void> {
  // Everything the file is built from is read here, before the first await.
  const snap = snapshotMeasure(deps.measure);
  const measurements = snap.measurements;
  if (measurements.length === 0) return;
  const layers = deps.layers ? exportLayersOf(deps.layers.view, deps.layers.stableIdFor) : [];
  if (refusedForClosedScan(measurements, deps)) return;
  const own = layers.length > 1 ? ownLayers(measurements, layers) : null;
  if (own && 'refused' in own) {
    deps.refuse?.(own.refused);
    return;
  }
  // Measurement points are LOCAL (recentered); add the origin back to land them
  // in the source projected/local frame. `geo()` resolves the origin for
  // streaming scans too (renderOrigin) — a static-only read would export at
  // render-frame coordinates.
  const geo = deps.geo();
  const origin: [number, number, number] = [geo.origin[0], geo.origin[1], geo.origin[2]];
  const generatedAt = deps.now();
  // Several layers: each point leaves through its own layer, undoing that
  // layer's placement and adding its file origin. The file names the sources
  // it holds; the digest and data basis describe the active scan, so they are
  // stated only when it is the one source.
  const sources = own ? [...new Set([...own.byId.values()].flatMap((p) => p.names))].sort((a, b) => a.localeCompare(b)) : null;
  const activeOnly = !sources || (sources.length === 1 && sources[0] === geo.name);
  const stems = sources ? sources.map(deps.baseName) : geo.name ? [deps.baseName(geo.name)] : [];
  const singleSource = geo.name ? deps.baseName(geo.name) : null;
  const sourceOfId = own ? new Map([...own.byId].map(([id, p]) => [id, p.names.map(deps.baseName).join('+')])) : null;
  // Read with the rest of the scan state, before the lazy import yields.
  const scanBasis = deps.activeScanBasis?.() ?? null;
  const exporter = await deps.loadMeasurementExport();
  const { measurementsToGeoJSON, measurementsToCsv, resolveExportDigests } = exporter;
  const digests = await resolveExportDigests(activeOnly ? geo.source : undefined, geo.crs);
  // From here on only the snapshot is read.
  const ctx: MeasurementExportContext = {
    toOutput: own
      ? (p, m) => {
          const b = own.byId.get(m!.id)!.base;
          return [p[0] + b[0], p[1] + b[1], p[2] + b[2]];
        }
      : (p) => [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]],
    sourceOf: sourceOfId ? (m) => sourceOfId.get(m.id)! : () => singleSource,
    up: snap.worldUp,
    unitToMetres: snap.unitToMetres,
    verticalUnitToMetres: snap.verticalUnitToMetres,
    crsName: geo.crsName,
    // The RESOLVED frame's own answer, not a literal. A geographic frame has no
    // scalar metres-per-unit at all, so it is neither verified nor convertible.
    geographic: snap.geographicCrs,
    // A local / unknown-unit scan has an inert factor of 1, so the `_m` columns
    // are nominal, not metres — the evidence note then says so (M1). An angular
    // frame is unverified for a stronger reason: no scalar could make it metres.
    unitsVerified: snap.unitsVerified,
    provenance: {
      generatedAt,
      source: stems.length > 0 ? stems.join('+') : null,
      crsName: geo.crsName,
      interpretation: activeOnly ? geo.interpretation : undefined,
      crs: geo.crs,
      digests,
    },
  };
  const text =
    format === 'geojson' ? measurementsToGeoJSON(measurements, ctx) : measurementsToCsv(measurements, ctx);
  const stem = stems.length > 0 ? stems.join('+') : 'measurements';
  const filename = `${stem}-measurements.${format === 'geojson' ? 'geojson' : 'csv'}`;
  deps.downloadText(filename, text);
  if (format === 'geojson' || !ctx.provenance) return;
  // A CSV has no comment slot every parser skips, so its provenance rides in a sidecar.
  const basis = csvBasis(scanBasis, activeOnly, sources?.length ?? 1, geo.name);
  const sidecar = exporter.provenanceSidecarName(filename);
  deps.downloadText(sidecar, exporter.measurementCsvProvenance(ctx.provenance, basis));
  deps.notify?.(csvSavedMessage(filename, sidecar));
}

/**
 * The toast after a CSV export. It names both files, because a browser can
 * block the second download until the user allows multiple downloads.
 */
export function csvSavedMessage(csv: string, sidecar: string): string {
  return `Saved ${csv} and ${sidecar}. If your browser asked to allow multiple downloads, allow it to get the provenance file.`;
}

/** The sidecar's scan facts: the active scan's own, or a statement that several scans are mixed. */
function csvBasis(
  scan: ActiveScanBasis | null,
  activeOnly: boolean,
  sourceCount: number,
  sourceName: string | null,
): { pointBasis: string; classesEdited: boolean | null; sourceName: string | null } {
  if (!activeOnly) {
    return { pointBasis: `Point basis: not recorded (measurements span ${sourceCount} scans)`, classesEdited: null, sourceName: null };
  }
  if (!scan) return { pointBasis: 'Point basis: not recorded (no active scan)', classesEdited: null, sourceName };
  return { pointBasis: scan.pointBasis, classesEdited: scan.classesEdited, sourceName };
}

/** Export the measurement integrity report (JSON) with its content digest. */
export async function exportMeasurementIntegrityReport(
  deps: MeasurementExportActionDeps,
): Promise<void> {
  const snap = snapshotMeasure(deps.measure);
  const ms = snap.measurements;
  if (ms.length === 0) return;
  if (refusedForClosedScan(ms, deps)) return;
  const geo = deps.geo();
  // Every scan-bound fact is read BEFORE the lazy import, so the report is one
  // scan's account of itself. The frame, unit scales, class epoch and
  // unit-known flag were read AFTER the await, so a scan swap while the chunk
  // loaded signed A's geometry and name with B's up vector, unit scale and
  // classification epoch — inside a file called an integrity report.
  const { worldUp, unitToMetres, verticalUnitToMetres } = snap;
  const classificationEpoch = deps.activeClassificationEpoch();
  // Local / unknown-unit scan → the findings' metre labels are nominal (M1).
  // A GEOGRAPHIC frame is unverified for a stronger reason than an unknown
  // one: no scalar metres-per-degree exists, so there is nothing to convert
  // by. The CSV/GeoJSON action next door has always read it this way; this
  // path read the bare `crsKnown` and so called a lon/lat scan unit-verified.
  const crsKnown = snap.unitsVerified;
  const generatedAt = deps.now();
  const { integrityReportFile, resolveExportDigests } = await deps.loadMeasurementReport();
  const digests = await resolveExportDigests(geo.source, geo.crs);
  const f = integrityReportFile(
    ms,
    worldUp,
    unitToMetres,
    verticalUnitToMetres,
    geo.name ? deps.baseName(geo.name) : 'scan',
    geo.crsName,
    generatedAt,
    classificationEpoch,
    deps.appVersion,
    crsKnown,
    undefined,
    digests,
  );
  deps.downloadText(f.filename, f.text);
}

/**
 * Convert the placed measurements into report findings for the findings ledger.
 * The panel's "Add current measurements" button drives this; the conversion
 * lives in the lazy report chunk, so the call is async. Returns an empty array
 * when nothing is placed.
 */
export async function collectMeasurementFindings(
  deps: MeasurementExportActionDeps,
): Promise<readonly ReportFinding[]> {
  const { measure } = deps;
  const ms = measure.getMeasurements();
  if (ms.length === 0) return [];
  // Same discipline: the frame the measurements were taken in, captured with
  // them rather than re-read after the import.
  const worldUp = measure.worldUp;
  const unitToMetres = measure.unitToMetres;
  const verticalUnitToMetres = measure.verticalUnitToMetres;
  const { measurementsToFindings } = await deps.loadMeasurementReport();
  return measurementsToFindings(ms, worldUp, unitToMetres, verticalUnitToMetres);
}

/** Export the curated findings ledger as the signed integrity report (JSON). */
export async function exportFindingsReport(
  deps: MeasurementExportActionDeps,
  findings: readonly ReportFinding[],
): Promise<void> {
  if (findings.length === 0) return;
  const geo = deps.geo();
  const classificationEpoch = deps.activeClassificationEpoch();
  // Geographic reads as unverified here too — see `exportIntegrityReport`.
  const crsKnown = deps.measure.crsKnown && !deps.measure.geographicCrs;
  const { findingsReportFile, resolveExportDigests } = await deps.loadMeasurementReport();
  const digests = await resolveExportDigests(geo.source, geo.crs);
  const f = findingsReportFile(
    findings,
    geo.name ? deps.baseName(geo.name) : 'scan',
    geo.crsName,
    deps.now(),
    classificationEpoch,
    deps.appVersion,
    crsKnown,
    undefined,
    digests,
  );
  deps.downloadText(f.filename, f.text);
}
