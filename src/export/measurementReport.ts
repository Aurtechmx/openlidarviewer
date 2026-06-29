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
): ReportFinding[] {
  const findings: ReportFinding[] = [];
  measurements.forEach((m, i) => {
    const metrics = measurementMetrics(m, up, unitToMetres);
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
      const V = L * L * L; // native render units³ → m³ (see VolumeRecord contract)
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

/**
 * One-call helper for the export handler: build + sign the report and return the
 * download filename and pretty-printed JSON. Positional args keep the eager call
 * site byte-cheap; the manifest assembly and serialization stay in this lazy
 * chunk. Verification re-canonicalizes, so pretty-printing the file is safe.
 */
export function integrityReportFile(
  measurements: readonly Measurement[],
  up: Vec3,
  unitToMetres: number,
  datasetId: string,
  crsName: string | undefined,
  generatedAt: string,
  classificationEpoch: number,
  software?: string,
): { readonly filename: string; readonly text: string } {
  const manifest = measurementsToReportManifest(measurements, up, unitToMetres, {
    datasetId,
    crsName,
    generatedAt,
    classificationEpoch,
    software,
  });
  return { filename: `${datasetId}-report.json`, text: JSON.stringify(manifest, null, 2) };
}

/** Build (and sign) a report manifest from the placed measurements. */
export function measurementsToReportManifest(
  measurements: readonly Measurement[],
  up: Vec3,
  unitToMetres: number,
  provenance: ReportProvenance,
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
      findings: measurementsToFindings(measurements, up, unitToMetres),
    },
    hashFn,
  );
}
