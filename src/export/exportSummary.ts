/**
 * exportSummary.ts
 *
 * The pure "what you'll get" core for point-cloud export — the single source of
 * truth behind the live summary line the Export panel and the splash
 * BatchConverter both show BEFORE a write runs. Given the active scan's facts
 * (point count, chosen format, CRS handling, classification provenance, whether
 * the loaded view is decimated), it computes an estimated file size, a CRS
 * label, a classification note, and the prevention warnings — so the user sees
 * exactly what is about to leave the app and is never surprised by a 2 GB
 * download or by shipping heuristic classes as if they were survey-grade.
 *
 * Honesty: every size is an ESTIMATE and labelled as one; LAZ is a compressed
 * RANGE (we can't know the exact ratio without encoding); ASCII formats are
 * flagged approximate. Warnings name the real consequence, never blame the user.
 *
 * Pure: no DOM, no three.js, no I/O. Deterministic. Mirrors the point-format
 * selection in writeLas.ts so the byte model tracks what is actually written.
 */

import type { ConvertFormat, CrsMode } from '../convert/types';
import { CONVERT_FORMATS } from '../convert/types';
import { formatByteSize } from '../io/formatByteSize';

/** Where the active classification came from. */
export type ClassificationProvenance = 'none' | 'source' | 'derived';

export interface ExportSummaryInput {
  /** Points that will be written (full-res count when `fullRes`, else loaded). */
  readonly pointCount: number;
  readonly format: ConvertFormat;
  /** Cloud carries RGB (drives PDRF 7/2/3 vs 6/0/1 → record length). */
  readonly hasRgb?: boolean;
  /** Cloud carries GPS time (drives LAS 1.2 PDRF 1/3). */
  readonly hasGpsTime?: boolean;
  readonly crsMode: CrsMode;
  /** Human CRS label when known (e.g. "EPSG:32612 — WGS 84 / UTM 12N"). */
  readonly crsLabel?: string | null;
  /** Target EPSG for assign/reproject. */
  readonly targetEpsg?: number | null;
  /** True when a real OGC WKT is available (LAS 1.4 `keep` prefers it). */
  readonly hasWkt?: boolean;
  readonly classification?: ClassificationProvenance;
  /** User toggle — write the classification channel, or omit it. Default true. */
  readonly includeClassification?: boolean;
  /** Confidence of a derived classification, 0..100, for the honest note. */
  readonly derivedConfidencePct?: number | null;
  /** The loaded view is a reduced/decimated subset of the source. */
  readonly viewDecimated?: boolean;
  /** User ticked "convert at full resolution". */
  readonly fullRes?: boolean;
  /** User ticked "Compress (.gz)" — gzip the LAS output (LAS formats only). */
  readonly gzip?: boolean;
}

export interface ExportWarning {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
}

export interface ExportSummary {
  readonly pointCountLabel: string;
  readonly formatLabel: string;
  /** "~310 MB", a LAZ range "~26–45 MB", or "" when no points. */
  readonly sizeLabel: string;
  /** Midpoint size estimate in bytes, or null when not estimable. */
  readonly sizeBytesEst: number | null;
  /** True when the size is a coarse approximation (ASCII / LAZ range). */
  readonly sizeApproximate: boolean;
  readonly crsLabel: string;
  /** "Classification included (derived)" etc., or null when there's none. */
  readonly classificationLabel: string | null;
  readonly warnings: readonly ExportWarning[];
  /** The composed single-line summary for the panel. */
  readonly line: string;
}

/** Public header block sizes (a fixed allowance; VLRs are negligible here). */
const LAS12_HEADER = 227;
const LAS14_HEADER = 375;
/** Nominal bytes/point for ASCII output at default (mm) precision — approximate. */
const ASCII_BYTES_PER_POINT = 34;
/** Typical LAZ compression of equivalent LAS for airborne/UAV LiDAR. */
const LAZ_RATIO_LO = 1 / 12;
const LAZ_RATIO_HI = 1 / 7;
/** Typical gzip compression of a binary LAS (container gzip, not LAZ). */
const GZIP_RATIO_LO = 0.25;
const GZIP_RATIO_HI = 0.5;
/** Above this, a download is "large" and worth a heads-up. */
const LARGE_FILE_BYTES = 1.5 * 1024 ** 3;

/** Record length for a binary LAS write, mirroring writeLas.ts format picking. */
function lasBytesPerPoint(format: 'las' | 'las14', hasRgb: boolean, hasGps: boolean): number {
  if (format === 'las14') return hasRgb ? 36 : 30; // PDRF 7 / 6
  if (hasRgb && hasGps) return 34; // PDRF 3
  if (hasRgb) return 26; // PDRF 2
  if (hasGps) return 28; // PDRF 1
  return 20; // PDRF 0
}

function crsLabelFor(i: ExportSummaryInput): string {
  const epsg = i.targetEpsg ? `EPSG:${i.targetEpsg}` : null;
  switch (i.crsMode) {
    case 'assign':
      return epsg ? `Assign ${epsg}` : 'Assign EPSG (choose a code)';
    case 'reproject':
      return epsg ? `Reproject → ${epsg}` : 'Reproject (choose a target)';
    case 'keep':
    default:
      return i.crsLabel ? i.crsLabel : 'Local — no CRS';
  }
}

/**
 * Compute the export summary. Returns labels + warnings; does not write anything.
 */
export function buildExportSummary(input: ExportSummaryInput): ExportSummary {
  const spec = CONVERT_FORMATS[input.format];
  const n = Math.max(0, Math.floor(input.pointCount));
  const hasRgb = input.hasRgb === true;
  const hasGps = input.hasGpsTime === true;
  const includeClass = input.includeClassification !== false;
  const provenance = input.classification ?? 'none';
  // Gzip applies only to the binary LAS writers (it wraps their bytes).
  const gzip = input.gzip === true && (input.format === 'las' || input.format === 'las14');

  // ── size estimate ────────────────────────────────────────────────────────
  let sizeBytesEst: number | null = null;
  let sizeApproximate = false;
  let sizeLabel = '';
  if (n > 0) {
    if (input.format === 'las14' || input.format === 'las') {
      const header = input.format === 'las14' ? LAS14_HEADER : LAS12_HEADER;
      const raw = header + n * lasBytesPerPoint(input.format, hasRgb, hasGps);
      if (gzip) {
        // Compressed container — report a range, like LAZ.
        sizeBytesEst = (raw * GZIP_RATIO_LO + raw * GZIP_RATIO_HI) / 2;
        sizeApproximate = true;
        sizeLabel = `~${formatByteSize(raw * GZIP_RATIO_LO)}–${formatByteSize(raw * GZIP_RATIO_HI)}`;
      } else {
        sizeBytesEst = raw;
        sizeLabel = `~${formatByteSize(raw)}`;
      }
    } else if (input.format === 'laz') {
      // Estimate from the LAS 1.4 raw size, then apply a compression RANGE.
      const raw = LAS14_HEADER + n * lasBytesPerPoint('las14', hasRgb, hasGps);
      const lo = raw * LAZ_RATIO_LO;
      const hi = raw * LAZ_RATIO_HI;
      sizeBytesEst = (lo + hi) / 2;
      sizeApproximate = true;
      sizeLabel = `~${formatByteSize(lo)}–${formatByteSize(hi)}`;
    } else {
      // XYZ / ASC — ASCII, genuinely variable with coordinate magnitude.
      sizeBytesEst = n * ASCII_BYTES_PER_POINT;
      sizeApproximate = true;
      sizeLabel = `~${formatByteSize(sizeBytesEst)}`;
    }
  }

  // ── classification note ──────────────────────────────────────────────────
  let classificationLabel: string | null = null;
  if (provenance !== 'none') {
    if (!includeClass) {
      classificationLabel = 'Classification omitted';
    } else if (provenance === 'derived') {
      const conf =
        typeof input.derivedConfidencePct === 'number'
          ? `, ${Math.round(input.derivedConfidencePct)}% confidence`
          : '';
      classificationLabel = `Classification included (derived${conf})`;
    } else {
      classificationLabel = 'Classification included (source)';
    }
  }

  // ── warnings (prevention) ────────────────────────────────────────────────
  const warnings: ExportWarning[] = [];
  if ((input.crsMode === 'assign' || input.crsMode === 'reproject') && !input.targetEpsg) {
    warnings.push({
      level: 'error',
      message:
        input.crsMode === 'reproject'
          ? 'Choose a target EPSG to reproject into before exporting.'
          : 'Enter the EPSG code to assign before exporting.',
    });
  }
  if (includeClass && provenance === 'derived') {
    warnings.push({
      level: 'warn',
      message:
        'This writes the DERIVED (heuristic) classification — not survey-grade. ' +
        'Validate it before anyone relies on it, or omit it below.',
    });
  }
  if (includeClass && provenance !== 'none' && input.format === 'las') {
    warnings.push({
      level: 'info',
      message:
        'LAS 1.2 clamps classification to 5 bits (classes above 31 are lost). ' +
        'Choose LAS 1.4 to keep the full 8-bit classification.',
    });
  }
  if (input.format === 'las14' && input.crsMode === 'keep' && input.crsLabel && input.hasWkt === false) {
    warnings.push({
      level: 'info',
      message:
        'CRS recorded as GeoTIFF keys — strict LAS 1.4 readers prefer OGC WKT for point formats 6/7.',
    });
  }
  if (input.viewDecimated && !input.fullRes) {
    warnings.push({
      level: 'warn',
      message:
        'Exporting the reduced display view, not every point. ' +
        'Tick "convert at full resolution" to write the whole scan.',
    });
  }
  if (sizeBytesEst != null && sizeBytesEst > LARGE_FILE_BYTES) {
    warnings.push({
      level: 'warn',
      message: `Large file (${sizeLabel.replace(/^~/, '~')}) — the download may take a while and use significant memory.`,
    });
  }

  // ── composed one-liner ───────────────────────────────────────────────────
  const pointCountLabel = `${n.toLocaleString()} point${n === 1 ? '' : 's'}`;
  const crsLabel = crsLabelFor(input);
  const formatLabel = gzip ? `${spec.label} (.gz)` : spec.label;
  const parts = [pointCountLabel, formatLabel];
  if (sizeLabel) parts.push(sizeLabel);
  parts.push(crsLabel);
  if (classificationLabel) parts.push(classificationLabel);
  const line = n > 0 ? parts.join(' · ') : 'Open a scan to export.';

  return {
    pointCountLabel,
    formatLabel,
    sizeLabel,
    sizeBytesEst,
    sizeApproximate,
    crsLabel,
    classificationLabel,
    warnings,
    line,
  };
}
