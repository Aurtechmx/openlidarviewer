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
  ReportBranding,
  ReportCoverInputs,
  ReportInputs,
  ReportProvenanceFingerprint,
  ReportSourceMetadata,
  ReportTemplateId,
  ReportVisualAsset,
} from './types';
import { scanQualityFromFacts, type ScanQualityFacts } from './ReportScanQuality';
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
   * Scene up-axis and vertical unit factor, so the PDF's measurement values
   * match the live tool on a Y-up scan and a compound CRS (M6). Default to
   * Z-up / single-unit — every pre-existing caller is unaffected.
   */
  readonly worldUp?: readonly [number, number, number];
  readonly verticalToMetres?: number;
  readonly technicalNotes?: string;
  /**
   * Provenance fingerprint from the classifier. When supplied AND the
   * selected template includes the `provenance` section, the PDF
   * renders a capture-type label + confidence badge + signals list +
   * literature-cited accuracy bounds. Read from the shared
   * `diagnostics/captureProvenance` store by `app/reportExport.ts`, so the
   * report module never sees the diagnostics types.
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
   * The raw Scan QA facts, as primitives read off the loaded cloud by the caller
   * (the resolved CRS, the classification-derived flag, attribute presence). The
   * composer turns them into the `source-quality` section here, in the lazy
   * report chunk, so the eager report-export path imports neither `georefStatus`
   * nor the builder. Omitted → the section is omitted entirely.
   */
  readonly scanQualityFacts?: ScanQualityFacts;
  /**
   * Annotation ordering — `'type'` groups issues together at the top,
   * `'createdAt'` (the default) reads chronologically. Mirrors the live
   * AnnotationPanel's two sort modes.
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
  return {
    templateId,
    branding: input.branding ?? {},
    cover,
    datasetRows: buildDatasetSummary(input.metadata),
    visuals: input.visuals,
    annotations: buildAnnotationRows(input.annotations, {
      sortBy: input.annotationSort ?? 'createdAt',
    }),
    measurements: buildMeasurementRows(
      input.measurements,
      input.unitSystem,
      input.unitToMetres ?? 1,
      input.worldUp ? [...input.worldUp] : [0, 0, 1],
      input.verticalToMetres ?? input.unitToMetres ?? 1,
    ),
    technicalNotes: input.technicalNotes,
    provenance: input.provenance,
    sourceMetadata: input.sourceMetadata,
    scanQuality: input.scanQualityFacts ? scanQualityFromFacts(input.scanQualityFacts) : undefined,
    // Synthesised once here so every template that includes the
    // `inspection-summary` section renders the same findings. Pure of the
    // renderer; the QL-tier gating lives in buildInspectionSummary.
    summary: buildInspectionSummary(input.metadata, input.provenance),
  };
}

