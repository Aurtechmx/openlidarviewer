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
  ReportTemplateId,
  ReportVisualAsset,
} from './types';
import {
  buildDatasetSummary,
  type MetadataInputs,
} from './ReportMetadataSection';
import { buildAnnotationRows } from './ReportAnnotationSection';
import { buildMeasurementRows } from './ReportMeasurementSection';
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
  readonly technicalNotes?: string;
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
  return {
    templateId,
    branding: input.branding ?? {},
    cover,
    datasetRows: buildDatasetSummary(input.metadata),
    visuals: input.visuals,
    annotations: buildAnnotationRows(input.annotations, {
      sortBy: input.annotationSort ?? (templateId === 'qa-validation' ? 'type' : 'createdAt'),
    }),
    measurements: buildMeasurementRows(input.measurements, input.unitSystem),
    technicalNotes: input.technicalNotes,
  };
}
