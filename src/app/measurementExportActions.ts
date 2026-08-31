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
}

export interface MeasurementExportActionDeps {
  readonly measure: MeasureExportView;
  /** Resolved export frame (origin + resolved CRS label + name), read once. */
  readonly geo: () => GeoExportContext;
  readonly baseName: (name: string) => string;
  readonly downloadText: (filename: string, text: string) => void;
  readonly loadMeasurementExport: () => Promise<
    Pick<typeof import('../export/measurementExport'), 'measurementsToGeoJSON' | 'measurementsToCsv'>
  >;
  readonly loadMeasurementReport: () => Promise<
    Pick<
      typeof import('../export/measurementReport'),
      'integrityReportFile' | 'measurementsToFindings' | 'findingsReportFile'
    >
  >;
  /** Active scan's classification epoch (0 when none), for the report manifest. */
  readonly activeClassificationEpoch: () => number;
  readonly appVersion: string;
  /** ISO timestamp source — injected so the report build stays deterministic. */
  readonly now: () => string;
}

/** Export the placed measurements as an open GeoJSON or CSV file. */
export async function exportMeasurementsFile(
  format: 'geojson' | 'csv',
  deps: MeasurementExportActionDeps,
): Promise<void> {
  const { measure } = deps;
  const measurements = measure.getMeasurements();
  if (measurements.length === 0) return;
  // Measurement points are LOCAL (recentered); add the origin back to land them
  // in the source projected/local frame. `geo()` resolves the origin for
  // streaming scans too (renderOrigin) — a static-only read would export at
  // render-frame coordinates. Resolved BEFORE the import below, so the frame and
  // the measurements come from one instant, not two.
  const geo = deps.geo();
  const ctx: MeasurementExportContext = {
    toOutput: (p) => [p[0] + geo.origin[0], p[1] + geo.origin[1], p[2] + geo.origin[2]],
    up: measure.worldUp,
    unitToMetres: measure.unitToMetres,
    verticalUnitToMetres: measure.verticalUnitToMetres,
    crsName: geo.crsName,
    geographic: false,
    // A local / unknown-unit scan has an inert factor of 1, so the `_m` columns
    // are nominal, not metres — the evidence note then says so (M1).
    unitsVerified: measure.crsKnown,
  };
  const { measurementsToGeoJSON, measurementsToCsv } = await deps.loadMeasurementExport();
  const text =
    format === 'geojson' ? measurementsToGeoJSON(measurements, ctx) : measurementsToCsv(measurements, ctx);
  const stem = geo.name ? deps.baseName(geo.name) : 'measurements';
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
  const { integrityReportFile } = await deps.loadMeasurementReport();
  const f = integrityReportFile(
    ms,
    measure.worldUp,
    measure.unitToMetres,
    measure.verticalUnitToMetres,
    geo.name ? deps.baseName(geo.name) : 'scan',
    geo.crsName,
    deps.now(),
    deps.activeClassificationEpoch(),
    deps.appVersion,
    // Local / unknown-unit scan → the findings' metre labels are nominal (M1).
    measure.crsKnown,
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
  const { measurementsToFindings } = await deps.loadMeasurementReport();
  return measurementsToFindings(ms, measure.worldUp, measure.unitToMetres, measure.verticalUnitToMetres);
}

/** Export the curated findings ledger as the signed integrity report (JSON). */
export async function exportFindingsReport(
  deps: MeasurementExportActionDeps,
  findings: readonly ReportFinding[],
): Promise<void> {
  if (findings.length === 0) return;
  const geo = deps.geo();
  const { findingsReportFile } = await deps.loadMeasurementReport();
  const f = findingsReportFile(
    findings,
    geo.name ? deps.baseName(geo.name) : 'scan',
    geo.crsName,
    deps.now(),
    deps.activeClassificationEpoch(),
    deps.appVersion,
    deps.measure.crsKnown,
  );
  deps.downloadText(f.filename, f.text);
}
