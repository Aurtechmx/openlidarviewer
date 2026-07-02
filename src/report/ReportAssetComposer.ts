/**
 * ReportAssetComposer.ts
 *
 * The bridge between live Viewer state and the report engine's pure
 * `ReportInputs`. Pulls the inputs the engine needs from the typed scan
 * adapter the Studio already uses, then assembles them into the engine's
 * input shape.
 *
 * Why a separate module: keeps `ReportEngine.ts` agnostic of where the
 * inputs came from (live Viewer / a saved session / a test fixture).
 * The composer is the only place that knows about the runtime adapter
 * shape.
 *
 * Pure of pdf-lib; takes only types from the report module + the runtime
 * adapter interface.
 */

import type {
  ReportAcceptanceRow,
  ReportBranding,
  ReportCoverInputs,
  ReportInputs,
  ReportProvenanceFingerprint,
  ReportSourceMetadata,
  ReportTemplateId,
  ReportVisualAsset,
} from './types';
import {
  buildDatasetSummary,
  type MetadataInputs,
} from './ReportMetadataSection';
import { buildAnnotationRows } from './ReportAnnotationSection';
import { buildMeasurementRows } from './ReportMeasurementSection';
import { buildInspectionSummary } from './ReportFindings';
import type { Annotation } from '../render/annotate/types';
import type { Measurement, UnitSystem } from '../render/measure/types';
import { DEFAULT_TEMPLATE_ID } from './ReportTemplates';

/**
 * Everything the composer needs to assemble a `ReportInputs`. Each field
 * is what a Studio call site already has access to — `metadata` is
 * exactly what the Scan Intelligence panel renders, `visuals` is a list
 * of pre-rendered PNG blobs the caller produced via the export Studio.
 */
export interface ComposeReportInputs {
  readonly templateId?: ReportTemplateId;
  readonly branding?: ReportBranding;
  readonly title: string;
  readonly subtitle?: string;
  readonly metadata: MetadataInputs;
  readonly visuals: readonly ReportVisualAsset[];
  readonly annotations: readonly Annotation[];
  readonly measurements: readonly Measurement[];
  readonly unitSystem: UnitSystem;
  /**
   * Render-units → metres factor for the measurement values (the scan CRS's
   * `linearUnitToMetres`, the same seam the live MeasureController applies).
   * Measurement records carry RENDER-unit coordinates, so a foot-based scan
   * needs this for the PDF to agree with the on-screen readouts. Default 1
   * (metre / local scans, and every pre-existing caller, are unaffected).
   */
  readonly unitToMetres?: number;
  /**
   * Optional caller-supplied acceptance rows for the `scan-acceptance`
   * template. When omitted, the composer derives a small set of
   * metadata-only rows from the loaded scan (point count, CRS,
   * RGB/classification/intensity presence) so the section is never
   * empty when the template is selected.
   */
  readonly acceptanceChecks?: readonly ReportAcceptanceRow[];
  readonly technicalNotes?: string;
  /**
   * Provenance fingerprint from the classifier. When supplied AND the
   * selected template includes the `provenance` section, the PDF
   * renders a capture-type label + confidence badge + signals list +
   * literature-cited accuracy bounds. Auto-computed by main.ts via
   * `classifyProvenance(signalsFor…(cloud))` — the report module never
   * sees the diagnostics types.
   */
  readonly provenance?: ReportProvenanceFingerprint;
  /**
   * v0.5.4 — the file's own declared source metadata (standard + extension
   * fields, verbatim), lifted from `cloud.metadata.sourceMetadata`. When
   * supplied AND the template includes the `source-metadata` section, the
   * PDF renders a "Declared source metadata" section under the explicit
   * "declared by the file, not verified" disclosure. Omitted → the section
   * is omitted entirely.
   */
  readonly sourceMetadata?: ReportSourceMetadata;
  /**
   * QA reports default to sorting annotations by type so issues group
   * together at the top. Engineering / survey reports default to
   * chronological. Mirrors the live AnnotationPanel's two sort modes.
   */
  readonly annotationSort?: 'createdAt' | 'type';
}

/**
 * Compose a `ReportInputs` from runtime + caller-supplied inputs. Pure;
 * runs in Node + browser identically.
 */
export function composeReportInputs(input: ComposeReportInputs): ReportInputs {
  const templateId = input.templateId ?? DEFAULT_TEMPLATE_ID;
  const cover: ReportCoverInputs = {
    title: input.title,
    subtitle: input.subtitle,
    datasetName: input.metadata.fileName,
    exportedAt: new Date().toISOString(),
  };
  // Acceptance checklist — only meaningful for the scan-acceptance
  // template. Caller-supplied rows win; otherwise we derive metadata-
  // only defaults so the section is never empty when the template is
  // chosen from the UI picker. The defaults are presence checks
  // (no cloud sampling), which fits the current release's deliberate
  // metadata-only constraint on this template.
  const acceptanceChecks =
    templateId === 'scan-acceptance'
      ? (input.acceptanceChecks ?? deriveDefaultAcceptanceChecks(input.metadata))
      : input.acceptanceChecks;
  return {
    templateId,
    branding: input.branding ?? {},
    cover,
    datasetRows: buildDatasetSummary(input.metadata),
    visuals: input.visuals,
    annotations: buildAnnotationRows(input.annotations, {
      sortBy: input.annotationSort ?? (templateId === 'qa-validation' ? 'type' : 'createdAt'),
    }),
    measurements: buildMeasurementRows(
      input.measurements,
      input.unitSystem,
      input.unitToMetres ?? 1,
    ),
    technicalNotes: input.technicalNotes,
    acceptanceChecks,
    provenance: input.provenance,
    sourceMetadata: input.sourceMetadata,
    // Synthesised once here so every template that includes the
    // `inspection-summary` section renders the same findings. Pure of the
    // renderer; the QL-tier gating lives in buildInspectionSummary.
    summary: buildInspectionSummary(input.metadata, input.provenance),
  };
}

/**
 * Derive metadata-only acceptance rows from the loaded scan. Five rows
 * cover the common deliverable checks a reviewer can answer without
 * sampling the cloud: a non-trivial point count, a declared CRS, and
 * the per-attribute presence of RGB / classification / intensity.
 *
 * Every threshold here is a presence check; thresholds that depend on
 * surface conditions (NPS, void map, RMSE) are deliberately deferred
 * to the analysis seam — adding them here would invite the
 * "USGS QL1/QL2 baked in" trap the current release explicitly avoids.
 */
function deriveDefaultAcceptanceChecks(
  metadata: MetadataInputs,
): readonly ReportAcceptanceRow[] {
  const rows: ReportAcceptanceRow[] = [];
  const hasPoints =
    typeof metadata.sourcePointCount === 'number' &&
    metadata.sourcePointCount > 0;
  rows.push({
    label: 'Point count',
    threshold: '> 0',
    actual: hasPoints
      ? metadata.sourcePointCount.toLocaleString('en-US')
      : 'unknown',
    pass: hasPoints,
  });
  rows.push({
    label: 'CRS declared',
    threshold: 'required',
    actual: metadata.crsName ?? 'missing',
    pass: typeof metadata.crsName === 'string' && metadata.crsName.length > 0,
    note: metadata.crsName
      ? undefined
      : 'No CRS declared — exports cannot be georeferenced without one.',
  });
  rows.push({
    label: 'RGB channel',
    threshold: 'informational',
    actual: metadata.hasRgb ? 'present' : 'absent',
    pass: true,
  });
  rows.push({
    label: 'Classification channel',
    threshold: 'informational',
    actual: metadata.hasClassification ? 'present' : 'absent',
    pass: true,
  });
  rows.push({
    label: 'Intensity channel',
    threshold: 'informational',
    actual: metadata.hasIntensity ? 'present' : 'absent',
    pass: true,
  });
  return rows;
}
