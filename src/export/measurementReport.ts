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
import { evidenceNote, evidenceStatus, unverifiedUnitsCaveat, type EvidenceStatus } from '../validation/exportEvidenceNote';
import type { ClaimId } from '../validation/evidenceRegistry';

/**
 * The claim the integrity report stands on (§19). REPORT-DIGEST is the tamper-
 * evident digest itself, which is E1 (unit-verified) and required E1 — so the
 * gate reports it VALIDATED. The exporter still routes through the gate rather
 * than asserting that: if the register ever lowers the digest below its bar, or
 * disables it, this exporter's verdict flips automatically.
 */
export const INTEGRITY_REPORT_CLAIM: ClaimId = 'REPORT-DIGEST';

export interface ReportProvenance {
  readonly datasetId: string;
  readonly crsName?: string;
  readonly pointCount?: number;
  /** ISO timestamp, supplied by the caller (keeps the build deterministic). */
  readonly generatedAt: string;
  readonly classificationEpoch?: number;
  /** Producing app version (e.g. "0.5.2"); lets a reader spot a stale report. */
  readonly software?: string;
  /** Statements qualifying every figure; see {@link reportNotes}. */
  readonly notes?: readonly string[];
}

/** Match the 3-dp rounding `measurementMetrics` applies to every other value. */
function roundTo3(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
}

/**
 * What the area-weighted grid measurement (L05) found the estimator does not
 * handle: a sharp step inside one cell (the step fixture read about 15% low),
 * clustered sparse data (reaches PREVIEW at best, never MEASURED), and two
 * real-data comparisons against the point-sample cross-check that disagreed
 * by 3.6% and 8.6% with no ground truth to say which was right.
 */
/**
 * The measured accuracy behind the grid figure (ledger L05). Both readings
 * are quoted: the per-run median error, and the per-case bias reading, which
 * orders the two estimators the other way.
 */
const GRID_ACCURACY_EVIDENCE =
  'Measured on 21 analytic cases: median per-run error 1.44% (grid) against ' +
  '6.71% (point sample); the per-case bias reading reverses the order, ' +
  '1.40% against 0.90%. Uniform-sampling worst case 18.3% against 31.9%.';

/** The input counts a lasso result carries, as one caveat, or null. */
function withheldCaveat(w: NonNullable<Measurement['volume']>['withheld']): string | null {
  if (!w) return null;
  if (w.excluded === 'unknown') {
    return `${w.analysed} of ${w.source} selected points analysed; Withheld flags unavailable, so any Withheld points were not excluded.`;
  }
  return `${w.analysed} of ${w.source} selected points analysed; ${w.excluded} Withheld excluded.`;
}

const GRID_KNOWN_LIMITATIONS =
  'Known limits: a sharp step falling inside one grid cell reads low by ' +
  'about 15%; clustered, sparse coverage reaches PREVIEW at best; two ' +
  'real-data comparisons against the point-sample cross-check disagreed by ' +
  '3.6% and 8.6% with no ground truth to settle either.';

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
        if (k.endsWith('_m2')) {
          unit = 'm²';
        } else if (k.endsWith('_m3')) {
          unit = 'm³';
        } else if (k.endsWith('_deg')) {
          unit = '°';
        } else if (k.endsWith('_pct')) {
          unit = '%';
        } else {
          unit = 'm';
        }
      }
    }
    if (value === null) return; // an incomplete measurement contributes nothing
    const label = m.name?.trim() || `${m.kind} ${i + 1}`;
    // Volume measurements carry the cut/fill split, a confidence tier, and the
    // streaming-resident caveat. The headline value is the NET (fill − cut); the
    // cut and fill components and any coverage caveat ride along so the report
    // shows the whole earthwork, not just the fill, and reads its own honesty.
    if (m.kind === 'volume' && m.volume) {
      const vol = m.volume;
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
      const footprint = `${(vol.footprintArea * L * L).toFixed(2)} m²`;
      const caveats: string[] = [];
      // A grid-owned lasso record's estimator is the area-weighted grid;
      // an unswitched record (the polygon tool, or one saved before the grid became its figure) keeps
      // its point-sample cut/fill as the only figure and needs none of this.
      if (vol.gridAuthority !== undefined) {
        caveats.push(
          vol.gridAuthority === 'withheld'
            ? `Area-weighted grid volume withheld (${vol.gridAuthorityReason || 'insufficient observations'}).`
            : `Area-weighted grid integration over the ${footprint} footprint${vol.gridAuthority === 'preview' ? ` (PREVIEW: ${vol.gridAuthorityReason})` : ''}. Cells with too little support reduce the reported footprint rather than reading as zero.`,
        );
        if (vol.crossCheck) {
          caveats.push(
            `Point-sample cross-check (${vol.crossCheck.method}): cut ${(vol.crossCheck.cut * V).toFixed(2)} m³ / fill ${(vol.crossCheck.fill * V).toFixed(2)} m³.`,
          );
        }
        caveats.push(GRID_KNOWN_LIMITATIONS, GRID_ACCURACY_EVIDENCE);
      } else {
        caveats.push(
          `Cut ${((vol.cut ?? 0) * V).toFixed(2)} m³ / fill ${((vol.fill ?? 0) * V).toFixed(2)} m³ over ${footprint} footprint.`,
          'Point-sample integration assumes uniform coverage inside the polygon.',
        );
      }
      const wc = withheldCaveat(vol.withheld);
      if (wc) caveats.push(wc);
      if (m.volumeResidentOnly) {
        caveats.push('Sampled from streaming resident points only — may refine as more nodes load.');
      }
      // Rounded to the same 3 dp every other finding passes through in
      // `measurementMetrics`. The raw product went out as a full float, so a
      // point-sampled volume printed to ~1e-14 m³ beside a distance at 1 mm,
      // implying a resolution its own coverage caveat denies.
      //
      // A withheld grid carries no net of its own; the
      // cross-check's net is reported instead, under a label that says so —
      // never silently as the (absent) grid figure.
      if (vol.net !== undefined) {
        findings.push({ label, value: roundTo3(vol.net * V), unit: 'm³', confidence: vol.confidence, caveats });
      } else if (vol.crossCheck) {
        findings.push({
          label: `${label} (point-sample cross-check — grid volume withheld)`,
          value: roundTo3(vol.crossCheck.net * V),
          unit: 'm³',
          confidence: vol.confidence,
          caveats,
        });
      }
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
  /**
   * True when the scan's linear scale is KNOWN. False for a local / unknown-unit
   * cloud, where the findings' `m` / `m²` labels are nominal — the evidence note
   * then carries the units caveat (pass-6 M1). Defaults true (unchanged callers).
   */
  unitsVerified: boolean = true,
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
    notes: reportNotes(unitsVerified, crsName),
  }, verticalToMetres);
  return {
    filename: `${datasetId}-report.json`,
    text: JSON.stringify(manifest, null, 2),
    evidence: evidenceNote(claimId) + unverifiedUnitsCaveat(unitsVerified),
    evidenceStatus: evidenceStatus(claimId),
    exploratory: gate.exploratoryOnly,
  };
}

/**
 * Ledger variant of {@link integrityReportFile}: sign a report built from an
 * already-assembled {@link ReportFinding} ledger (the findings panel's curated
 * list) rather than re-deriving findings from live measurements. Same gate, same
 * manifest builder, same digest — only the finding source differs. The reviewer
 * has chosen and pruned these findings, so their bands and caveats travel as-is.
 */
export function findingsReportFile(
  findings: readonly ReportFinding[],
  datasetId: string,
  crsName: string | undefined,
  generatedAt: string,
  classificationEpoch: number,
  software?: string,
  unitsVerified: boolean = true,
  claimId: string = INTEGRITY_REPORT_CLAIM,
): IntegrityReportFile {
  const gate = exportGate(claimId);
  if (!gate.allowed && !gate.exploratoryOnly) {
    throw new Error(`Findings report refused: ${gate.reason}`);
  }
  const manifest = buildReportManifest({
    dataset: { id: datasetId, crs: crsName },
    generatedAt,
    software,
    classificationEpoch,
    findings: [...findings],
    notes: reportNotes(unitsVerified, crsName),
  });
  return {
    filename: `${datasetId}-findings.json`,
    text: JSON.stringify(manifest, null, 2),
    evidence: evidenceNote(claimId) + unverifiedUnitsCaveat(unitsVerified),
    evidenceStatus: evidenceStatus(claimId),
    exploratory: gate.exploratoryOnly,
  };
}

/**
 * The statements that qualify every figure in a report file.
 *
 * Both report builders computed these into the returned `evidence` string,
 * and the only caller downloads `text` and discards the rest — so an
 * unknown-unit scan's report went out labelling nominal source units as
 * metres with no caveat in the document at all, while the CSV and GeoJSON
 * for the same scan renamed their columns and carried the note. These go
 * INTO the manifest, where the digest covers them.
 */
function reportNotes(unitsVerified: boolean, crsName: string | undefined): string[] {
  const notes: string[] = [];
  const units = unverifiedUnitsCaveat(unitsVerified).trim();
  if (units) notes.push(units);
  // An absent `crs` key is indistinguishable from an older build that did not
  // record one. Saying so is shorter than leaving the reader to guess.
  if (!crsName) {
    notes.push(
      'No coordinate reference system was resolved for this scan, so the ' +
      'coordinates are in the source file\'s own frame.',
    );
  }
  return notes;
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
      notes: provenance.notes,
      findings: measurementsToFindings(measurements, up, unitToMetres, verticalToMetres),
    },
    hashFn,
  );
}
