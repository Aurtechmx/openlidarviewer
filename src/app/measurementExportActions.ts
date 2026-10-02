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
    Pick<typeof import('../export/measurementExport'), 'measurementsToGeoJSON' | 'measurementsToCsv' | 'resolveExportDigests'>
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
  /** Active scan's classification epoch (0 when none), for the report manifest. */
  readonly activeClassificationEpoch: () => number;
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
  for (const m of measurements) {
    const picked = m.pickLayers && m.pickLayers.length > 0;
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
    byId.set(m.id, { base: bases[0]!, names: [...new Set(ls.map((l) => l!.name))].sort() });
  }
  if (unknown > 0) {
    return { refused: `Not exported: ${unknown} of ${measurements.length} measurements have no recorded scan, so their coordinates cannot be placed. Close every scan but the one the measurements were taken on, then export again.` };
  }
  if (split.length > 0) {
    return { refused: `Not exported: ${split.join(', ')} has points on scans whose heights are not in one frame. Delete it or measure on one scan, then export again.` };
  }
  if (crs.size > 1) {
    return { refused: 'Not exported: the measurements come from scans with different coordinate systems. Export them one scan at a time.' };
  }
  return { byId };
}

/** Export the placed measurements as an open GeoJSON or CSV file. */
export async function exportMeasurementsFile(
  format: 'geojson' | 'csv',
  deps: MeasurementExportActionDeps,
): Promise<void> {
  const { measure } = deps;
  const measurements = measure.getMeasurements();
  if (measurements.length === 0) return;
  const layers = deps.layers ? exportLayersOf(deps.layers.view, deps.layers.stableIdFor) : [];
  const own = layers.length > 1 ? ownLayers(measurements, layers) : null;
  if (own && 'refused' in own) {
    deps.refuse?.(own.refused);
    return;
  }
  // Measurement points are LOCAL (recentered); add the origin back to land them
  // in the source projected/local frame. `geo()` resolves the origin for
  // streaming scans too (renderOrigin) — a static-only read would export at
  // render-frame coordinates. Resolved BEFORE the import below, so the frame and
  // the measurements come from one instant, not two.
  const geo = deps.geo();
  // Several layers: each point leaves through its own layer, undoing that
  // layer's placement and adding its file origin. The file names the sources
  // it holds; the digest and data basis describe the active scan, so they are
  // stated only when it is the one source.
  const sources = own ? [...new Set([...own.byId.values()].flatMap((p) => p.names))].sort() : null;
  const activeOnly = !sources || (sources.length === 1 && sources[0] === geo.name);
  const stems = sources ? sources.map(deps.baseName) : geo.name ? [deps.baseName(geo.name)] : [];
  const { measurementsToGeoJSON, measurementsToCsv, resolveExportDigests } = await deps.loadMeasurementExport();
  const digests = await resolveExportDigests(activeOnly ? geo.source : undefined, geo.crs);
  // `source` is the same extension-free name the provenance and file name use.
  const ctx: MeasurementExportContext = {
    toOutput: own
      ? (p, m) => {
          const b = own.byId.get(m!.id)!.base;
          return [p[0] + b[0], p[1] + b[1], p[2] + b[2]];
        }
      : (p) => [p[0] + geo.origin[0], p[1] + geo.origin[1], p[2] + geo.origin[2]],
    sourceOf: own ? (m) => own.byId.get(m.id)!.names.map(deps.baseName).join('+') : () => (geo.name ? deps.baseName(geo.name) : null),
    up: measure.worldUp,
    unitToMetres: measure.unitToMetres,
    verticalUnitToMetres: measure.verticalUnitToMetres,
    crsName: geo.crsName,
    // The RESOLVED frame's own answer, not a literal. A geographic frame has no
    // scalar metres-per-unit at all, so it is neither verified nor convertible.
    geographic: measure.geographicCrs,
    // A local / unknown-unit scan has an inert factor of 1, so the `_m` columns
    // are nominal, not metres — the evidence note then says so (M1). An angular
    // frame is unverified for a stronger reason: no scalar could make it metres.
    unitsVerified: measure.crsKnown && !measure.geographicCrs,
    provenance: {
      generatedAt: deps.now(),
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
  deps.downloadText(`${stem}-measurements.${format === 'geojson' ? 'geojson' : 'csv'}`, text);
}

/** Export the signed measurement integrity report (JSON). */
export async function exportMeasurementIntegrityReport(
  deps: MeasurementExportActionDeps,
): Promise<void> {
  const { measure } = deps;
  const ms = measure.getMeasurements();
  if (ms.length === 0) return;
  const geo = deps.geo();
  // Every scan-bound fact is read BEFORE the lazy import, so the report is one
  // scan's account of itself. The frame, unit scales, class epoch and
  // unit-known flag were read AFTER the await, so a scan swap while the chunk
  // loaded signed A's geometry and name with B's up vector, unit scale and
  // classification epoch — inside a file called an integrity report.
  const worldUp = measure.worldUp;
  const unitToMetres = measure.unitToMetres;
  const verticalUnitToMetres = measure.verticalUnitToMetres;
  const classificationEpoch = deps.activeClassificationEpoch();
  // Local / unknown-unit scan → the findings' metre labels are nominal (M1).
  // A GEOGRAPHIC frame is unverified for a stronger reason than an unknown
  // one: no scalar metres-per-degree exists, so there is nothing to convert
  // by. The CSV/GeoJSON action next door has always read it this way; this
  // path read the bare `crsKnown` and so called a lon/lat scan unit-verified.
  const crsKnown = measure.crsKnown && !measure.geographicCrs;
  const { integrityReportFile, resolveExportDigests } = await deps.loadMeasurementReport();
  const digests = await resolveExportDigests(geo.source, geo.crs);
  const f = integrityReportFile(
    ms,
    worldUp,
    unitToMetres,
    verticalUnitToMetres,
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
