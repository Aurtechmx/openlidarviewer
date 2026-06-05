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
  readonly format: 'COPC' | 'EPT' | 'LAS' | 'LAZ' | 'PLY' | 'E57' | 'PCD' | 'PTX' | 'PTS' | 'OBJ' | 'GLTF' | 'XYZ' | string;
  readonly sourcePointCount: number;
  /** Bounds in metres: width × depth × height. Pass NaN when unknown. */
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** Source point density in pts/m² on the XY footprint. NaN when unknown. */
  readonly density: number;
  readonly hasRgb: boolean;
  readonly hasIntensity: boolean;
  readonly hasClassification: boolean;
  /** CRS label + linear unit when the source carries projection metadata. */
  readonly crsName?: string;
  readonly crsUnit?: string;
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
}

/** Format a metre value: km / m / cm depending on magnitude. */
function formatMetres(m: number): string {
  if (!Number.isFinite(m)) return 'unknown';
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 10) return `${m.toFixed(1)} m`;
  if (m >= 1) return `${m.toFixed(2)} m`;
  return `${(m * 100).toFixed(1)} cm`;
}

/** Pretty-format an integer point count with locale separators. */
function formatInt(n: number): string {
  if (!Number.isFinite(n)) return 'unknown';
  return n.toLocaleString('en-US');
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
    { label: 'Points', value: formatInt(inputs.sourcePointCount) },
    { label: 'Width',  value: formatMetres(inputs.width) },
    { label: 'Depth',  value: formatMetres(inputs.depth) },
    { label: 'Height', value: formatMetres(inputs.height) },
  );
  if (Number.isFinite(inputs.density) && inputs.density > 0) {
    rows.push({ label: 'Density', value: `${inputs.density.toFixed(0)} pts/m²` });
  }
  rows.push({ label: 'RGB',            value: inputs.hasRgb ? 'Yes' : 'No' });
  rows.push({ label: 'Intensity',      value: inputs.hasIntensity ? 'Yes' : 'No' });
  rows.push({ label: 'Classification', value: inputs.hasClassification ? 'Yes' : 'No' });
  if (inputs.crsName) {
    rows.push({ label: 'CRS',   value: inputs.crsName });
  }
  if (inputs.crsUnit) {
    rows.push({ label: 'Units', value: inputs.crsUnit });
  }
  return rows;
}
