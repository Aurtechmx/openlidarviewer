/**
 * ReportMetadataSection.ts
 *
 * Builds the dataset-summary row list the metadata section renders.
 * Pure data — takes a typed `MetadataInputs` (the report engine's view
 * of the live scan) and returns the formatted `ReportDatasetRow[]` the
 * renderer lays out as a label / value table.
 *
 * Tests pin: the row order, the formatted units, the optional rows
 * (CRS only when known, etc.).
 */

import type { ReportDatasetRow } from './types';

/** What `buildDatasetSummary` needs to know about the scan. */
export interface MetadataInputs {
  readonly fileName: string;
  readonly format: 'COPC' | 'EPT' | 'LAS' | 'LAZ' | 'PLY' | 'E57' | 'PCD' | 'PTX' | 'PTS' | 'OBJ' | 'GLTF' | 'XYZ' | (string & {});
  readonly sourcePointCount: number | null;
  /** Bounds in metres: width × depth × height. Pass NaN when unknown. */
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** Source point density in pts/m² on the XY footprint. NaN when unknown. */
  readonly density: number;
  readonly hasRgb: boolean;
  readonly hasIntensity: boolean;
  readonly hasClassification: boolean;
  /**
   * Share of points carrying ASPRS code 0 (Created) or 1 (Unclassified) — the
   * same rule as `render/class/classificationCoverage`. Absent when the channel
   * is missing or the share cannot be counted (streaming), in which case the
   * row states presence only.
   */
  readonly unclassifiedFraction?: number;
  /** `unclassifiedFraction` was counted on the display sample, not the file. */
  readonly unclassifiedOfDisplaySample?: boolean;
  /** The classification was derived in the viewer (heuristic), not supplied. */
  readonly classificationDerived?: boolean;
  /** CRS label + linear unit when the source carries projection metadata. */
  readonly crsName?: string;
  readonly crsUnit?: string;
  /**
   * Whether the extent figures above are in confirmed metres. Absent (or
   * `'confirmed'`) means `width`/`depth`/`height` are metres and `density` is
   * pts·m⁻² — the summary is byte-identical to the pre-feature output. When
   * `'unknown'`, the CRS declares no real linear unit: `width`/`depth`/`height`
   * are RAW SOURCE-UNIT spans and `density` is NaN, so the summary prints the
   * extents with a "source units" suffix, omits the density row, and adds a
   * visible "units unconfirmed" warning rather than stamping metres on feet /
   * degrees. Set by `footprintToMetadataExtent` behind the `isLinearUnitKnown`
   * gate.
   */
  readonly extentUnitStatus?: 'confirmed' | 'unknown';
  /**
   * Active class-filter scope stamp — e.g. `"Ground + Building · 2 of 5
   * classes"`. Present ONLY while a class filter narrows the live view at
   * export time. When set, the dataset-summary table prepends an honesty row
   * disclosing the filter and warning that the figures below remain
   * full-cloud (the PDF's own figures are not re-derived per visible class —
   * the row makes that explicit rather than presenting filter-affected-looking
   * numbers silently). Absent / empty for an unfiltered export, in which case
   * the row list is byte-identical to the pre-feature output.
   */
  readonly classScopeNote?: string;
  /**
   * Streaming-preview accounting for COPC / EPT scans. When the report is
   * generated mid-stream, every figure in the PDF describes the FULL source
   * cloud, but only a resident subset has actually been decoded into memory.
   * This optional block lets the dataset summary disclose how much of the
   * cloud was loaded at export time — an honesty row so a reader does not
   * assume the whole cloud was inspected. Absent for fully-static formats
   * (LAS / PLY / E57 / …), where every point is resident by definition.
   */
  readonly streamingResident?: {
    /** Points decoded + resident in the viewer at export time. */
    readonly points: number;
    /** Resident octree nodes at export time. */
    readonly nodes: number;
    /** Total known octree nodes in the hierarchy. */
    readonly totalNodes: number;
  };
}

/** Format a metre value: km / m / cm depending on magnitude. */
function formatMetres(m: number): string {
  if (!Number.isFinite(m)) return 'unknown';
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 10) return `${m.toFixed(1)} m`;
  if (m >= 1) return `${m.toFixed(2)} m`;
  return `${(m * 100).toFixed(1)} cm`;
}

/**
 * Format a raw source-unit extent — used when the CRS declares no real linear
 * unit. No km/m/cm scaling and no "m" label: the magnitude's unit is unknown,
 * so the value is shown verbatim with an explicit "(source units)" suffix.
 */
function formatSourceUnits(n: number): string {
  if (!Number.isFinite(n)) return 'unknown';
  return `${n.toFixed(1)} (source units)`;
}

/** Pretty-format an integer point count with locale separators. */
function formatInt(n: number): string {
  if (!Number.isFinite(n)) return 'unknown';
  return n.toLocaleString('en-US');
}

/** Compact point count — "15.7M" / "4.2M" / "950K" / "420". Mirrors the live panel. */
function formatCompactCount(n: number): string {
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/**
 * "Yes" alone states presence, which a reader takes for a classified cloud.
 * When the share of ASPRS 0/1 codes is known it is printed next to presence,
 * and a viewer-derived classification says so, so the row states what the
 * on-screen scan report states.
 */
function classificationValue(inputs: MetadataInputs): string {
  if (!inputs.hasClassification) return 'No';
  const parts: string[] = [];
  if (inputs.classificationDerived) parts.push('derived by the viewer (heuristic)');
  const u = inputs.unclassifiedFraction;
  if (u !== undefined && Number.isFinite(u)) {
    if (u <= 0) {
      parts.push('every point carries a class');
    } else {
      const scope = inputs.unclassifiedOfDisplaySample ? ', of display sample' : '';
      parts.push(`${(u * 100).toFixed(1)} % ASPRS code 0/1 (unclassified${scope})`);
    }
  }
  return parts.length > 0 ? `Yes — ${parts.join('; ')}` : 'Yes';
}

/**
 * Build the ordered row list for the dataset-summary section.
 * Each row is `{ label, value }`. Order: identity → counts → extents →
 * capabilities → projection. Optional rows (CRS) appear only when known.
 */
export function buildDatasetSummary(inputs: MetadataInputs): readonly ReportDatasetRow[] {
  const rows: ReportDatasetRow[] = [];
  // Class-filter honesty row — prepended so it reads before the figures it
  // qualifies. Present only while a filter is active; an unfiltered export
  // omits it entirely, keeping the row list byte-identical to before.
  const scopeNote = inputs.classScopeNote?.trim();
  if (scopeNote) {
    rows.push({
      label: 'Class filter',
      value: `${scopeNote} — figures below are full-cloud`,
    });
  }
  rows.push(
    { label: 'File',   value: inputs.fileName },
    { label: 'Format', value: inputs.format },
    {
      label: 'Points',
      // Unknown, not zero: a source that cannot state its total has not
      // stated that it is empty.
      value: inputs.sourcePointCount === null
        ? 'Unknown from source metadata'
        : formatInt(inputs.sourcePointCount),
    },
  );
  // Streaming-preview disclosure — for a COPC / EPT scan exported mid-stream,
  // surface how much of the cloud is actually resident. Reads directly below
  // the full-cloud "Points" total so the relationship is unambiguous, and
  // tells the reviewer the figures reflect a partial preview, not the full
  // decode. Omitted entirely for static formats (every point resident).
  const sr = inputs.streamingResident;
  if (sr && Number.isFinite(sr.points) && sr.points > 0) {
    const total = inputs.sourcePointCount;
    const pct =
      total !== null && Number.isFinite(total) && total > 0
        ? Math.min(100, Math.round((sr.points / total) * 100))
        : Number.NaN;
    const nodePart =
      Number.isFinite(sr.totalNodes) && sr.totalNodes > 0
        ? ` · ${sr.nodes}/${sr.totalNodes} nodes`
        : '';
    const pctPart = Number.isFinite(pct) ? ` (${pct}%${nodePart})` : '';
    rows.push({
      label: 'Loaded',
      value:
        total === null
          ? `${formatCompactCount(sr.points)} resident, source total unknown — streaming preview`
          : `${formatCompactCount(sr.points)} of ${formatCompactCount(total)} pts${pctPart} — streaming preview`,
    });
  }
  // FAIL CLOSED on an unconfirmed linear unit. When the CRS declares no real
  // linear unit the extents are raw source-unit spans, not metres — a warning
  // row discloses that, the extents carry a "(source units)" suffix instead of
  // "m", and the density row is omitted (density is NaN, caught below). A
  // confirmed unit (or the absent default) is byte-identical to before.
  const unitsUnconfirmed = inputs.extentUnitStatus === 'unknown';
  if (unitsUnconfirmed) {
    rows.push(
      { label: 'Units',  value: 'Unconfirmed — extents in source units' },
      { label: 'Width',  value: formatSourceUnits(inputs.width) },
      { label: 'Depth',  value: formatSourceUnits(inputs.depth) },
      { label: 'Height', value: formatSourceUnits(inputs.height) },
    );
  } else {
    rows.push(
      { label: 'Width',  value: formatMetres(inputs.width) },
      { label: 'Depth',  value: formatMetres(inputs.depth) },
      { label: 'Height', value: formatMetres(inputs.height) },
    );
  }
  if (Number.isFinite(inputs.density) && inputs.density > 0) {
    // One decimal — same as the Inspection-summary finding and the on-screen
    // panel. Integer rounding printed 2.586 as "3", disagreeing with them.
    rows.push({ label: 'Density', value: `${inputs.density.toFixed(1)} pts/m²` });
  }
  rows.push(
    { label: 'RGB',            value: inputs.hasRgb ? 'Yes' : 'No' },
    { label: 'Intensity',      value: inputs.hasIntensity ? 'Yes' : 'No' },
    { label: 'Classification', value: classificationValue(inputs) },
  );
  if (inputs.crsName) {
    rows.push({ label: 'CRS',   value: inputs.crsName });
  }
  // The dedicated "Units — Unconfirmed …" warning above already states the unit
  // status, so skip the redundant `crsUnit` row (which would read "unknown").
  if (!unitsUnconfirmed && inputs.crsUnit) {
    rows.push({ label: 'Units', value: inputs.crsUnit });
  }
  return rows;
}
