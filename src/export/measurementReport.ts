/**
 * measurementReport.ts
 *
 * Turns the placed measurements into a tamper-evident integrity report manifest
 * — the "Integrity report (JSON)" product, a sibling of the GeoJSON / CSV export.
 *
 * Each measurement becomes a {@link ReportFinding} carrying its primary metric
 * in metres / m² / m³, and the whole document is stamped with dataset
 * provenance, the classification edit epoch, and a content digest (so a recipient
 * can detect a figure changed without recomputing the digest — a casual-edit
 * guard, not a cryptographic signature). Lengths are reported in metres via the
 * same `unitToMetres` factor the other exports use.
 *
 * Pure and unit-testable; the call site supplies the live measurements,
 * up-axis, unit factor, and provenance.
 */

import type { Measurement, Vec3 } from '../render/measure/types';
import { measurementMetrics } from './measurementExport';
import {
  buildReportManifest,
  type ReportFinding,
  type ReportManifest,
} from '../render/measure/reportManifest';
import type { HashFn } from '../render/measure/auditLog';
import { exportGate } from '../validation/evidenceRegistry';
import { evidenceNote, evidenceStatus, type EvidenceStatus } from '../validation/exportEvidenceNote';

/**
 * The claim the integrity report stands on (§19). REPORT-DIGEST is the tamper-
 * evident digest itself, which is E1 (unit-verified) and required E1 — so the
 * gate reports it VALIDATED. The exporter still routes through the gate rather
 * than asserting that: if the register ever lowers the digest below its bar, or
 * disables it, this exporter's verdict flips automatically.
 */
export const INTEGRITY_REPORT_CLAIM = 'REPORT-DIGEST';

export interface ReportProvenance {
  readonly datasetId: string;
  readonly crsName?: string;
  readonly pointCount?: number;
  /** ISO timestamp, supplied by the caller (keeps the build deterministic). */
  readonly generatedAt: string;
  readonly classificationEpoch?: number;
  /** Producing app version (e.g. "0.5.2"); lets a reader spot a stale report. */
  readonly software?: string;
}

/** The headline metric + unit for each measurement kind. */
const PRIMARY: Record<string, { readonly key: string; readonly unit: string }> = {
  distance: { key: 'length_m', unit: 'm' },
  polyline: { key: 'length_m', unit: 'm' },
  height: { key: 'vertical_m', unit: 'm' },
  angle: { key: 'angle_deg', unit: '°' },
  slope: { key: 'grade_pct', unit: '%' },
  profile: { key: 'length_m', unit: 'm' },
  area: { key: 'area_m2', unit: 'm²' },
  box: { key: 'volume_m3', unit: 'm³' },
  volume: { key: 'fill_m3', unit: 'm³' },
};

/** One report finding per measurement, using its primary metric. */
export function measurementsToFindings(
  measurements: readonly Measurement[],
  up: Vec3,
  unitToMetres: number,
  /**
   * VERTICAL render-units → metres. Defaults to `unitToMetres`, so a
   * single-unit CRS is unchanged; it differs only for a compound CRS (metre
   * eastings over foot heights), where one factor cannot describe both axes.
   */
  verticalToMetres: number = unitToMetres,
): ReportFinding[] {
  const findings: ReportFinding[] = [];
  measurements.forEach((m, i) => {
    const metrics = measurementMetrics(m, up, unitToMetres, verticalToMetres);
    const primary = PRIMARY[m.kind];
    let value: number | null = null;
    let unit = '';
    if (primary && Number.isFinite(metrics[primary.key])) {
      value = metrics[primary.key];
      unit = primary.unit;
    } else {
      // Fallback: the first metric the geometry could establish.
      const k = Object.keys(metrics).find((key) => Number.isFinite(metrics[key]));
      if (k) {
        value = metrics[k];
        unit = k.endsWith('_m2') ? 'm²' : k.endsWith('_m3') ? 'm³' : k.endsWith('_deg') ? '°' : k.endsWith('_pct') ? '%' : 'm';
      }
    }
    if (value === null) return; // an incomplete measurement contributes nothing
    const label = m.name?.trim() || `${m.kind} ${i + 1}`;
    // Volume measurements carry the cut/fill split, a confidence tier, and the
    // streaming-resident caveat. The headline value is the NET (fill − cut); the
    // cut and fill components and any coverage caveat ride along so the report
    // shows the whole earthwork, not just the fill, and reads its own honesty.
    if (m.kind === 'volume' && m.volume) {
      const L = unitToMetres;
      // Guard the vertical factor exactly as `measurementExport` does; a zero,
      // NaN or negative value would otherwise make this report and the CSV
      // disagree about the same volume — the divergence this file exists to end.
      const Vv =
        Number.isFinite(verticalToMetres) && verticalToMetres > 0 ? verticalToMetres : L;
      // Cubic factor is linear²·vertical, matching `measurementExport`'s `Vol`.
      // Plain L³ applied the HORIZONTAL unit to the vertical axis, overstating
      // a metre/US-foot compound volume by 3.28×.
      const V = L * L * Vv; // native render units³ → m³
      const net = m.volume.net * V;
      const caveats = [
        `Cut ${(m.volume.cut * V).toFixed(2)} m³ / fill ${(m.volume.fill * V).toFixed(2)} m³ over ${(m.volume.footprintArea * L * L).toFixed(2)} m² footprint.`,
        'Point-sample integration assumes uniform coverage inside the polygon.',
      ];
      if (m.volumeResidentOnly) {
        caveats.push('Sampled from streaming resident points only — may refine as more nodes load.');
      }
      findings.push({ label, value: net, unit: 'm³', confidence: m.volume.confidence, caveats });
      return;
    }
    findings.push({ label, value, unit });
  });
  return findings;
}

/** The output of {@link integrityReportFile}: the artifact plus its gate verdict. */
export interface IntegrityReportFile {
  readonly filename: string;
  readonly text: string;
  /** The central gate verdict for the integrity-report product (§19). */
  readonly evidence: string;
  /** Compact claim status ('validated' when the digest meets its bar). */
  readonly evidenceStatus: EvidenceStatus;
  /** True when the product may leave only as an exploratory artifact. */
  readonly exploratory: boolean;
}

/**
 * One-call helper for the export handler: build + sign the report and return the
 * download filename and pretty-printed JSON. Positional args keep the eager call
 * site byte-cheap; the manifest assembly and serialization stay in this lazy
 * chunk. Verification re-canonicalizes, so pretty-printing the file is safe.
 *
 * §19: the export DECISION now routes through the one gate. A product the
 * register marks not-exportable is refused outright (throws); otherwise the
 * artifact is produced and its gate verdict (validated / exploratory) travels
 * back on the result so the caller can watermark / flag it. The verdict is
 * NEVER promoted here — it is whatever the registry says for `claimId`.
 */
export function integrityReportFile(
  measurements: readonly Measurement[],
  up: Vec3,
  unitToMetres: number,
  /** VERTICAL render-units → metres; pass `unitToMetres` for a single-unit CRS. */
  verticalToMetres: number,
  datasetId: string,
  crsName: string | undefined,
  generatedAt: string,
  classificationEpoch: number,
  software?: string,
  claimId: string = INTEGRITY_REPORT_CLAIM,
): IntegrityReportFile {
  const gate = exportGate(claimId);
  // A product the register disables entirely never leaves — not even as an
  // exploratory artifact. (No current claim is disabled; this is the honest
  // floor so a future `exportAllowed: false` is enforced, not bypassed.)
  if (!gate.allowed && !gate.exploratoryOnly) {
    throw new Error(`Integrity report refused: ${gate.reason}`);
  }
  const manifest = measurementsToReportManifest(measurements, up, unitToMetres, {
    datasetId,
    crsName,
    generatedAt,
    classificationEpoch,
    software,
  }, verticalToMetres);
  return {
    filename: `${datasetId}-report.json`,
    text: JSON.stringify(manifest, null, 2),
    evidence: evidenceNote(claimId),
    evidenceStatus: evidenceStatus(claimId),
    exploratory: gate.exploratoryOnly,
  };
}

/** Build (and sign) a report manifest from the placed measurements. */
export function measurementsToReportManifest(
  measurements: readonly Measurement[],
  up: Vec3,
  unitToMetres: number,
  provenance: ReportProvenance,
  verticalToMetres: number = unitToMetres,
  hashFn?: HashFn,
): ReportManifest {
  return buildReportManifest(
    {
      dataset: {
        id: provenance.datasetId,
        crs: provenance.crsName,
        pointCount: provenance.pointCount,
      },
      generatedAt: provenance.generatedAt,
      software: provenance.software,
      classificationEpoch: provenance.classificationEpoch,
      findings: measurementsToFindings(measurements, up, unitToMetres, verticalToMetres),
    },
    hashFn,
  );
}
