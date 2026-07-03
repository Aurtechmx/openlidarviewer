/**
 * report/index.ts
 *
 * Barrel for the PDF Report Engine. The whole module lives behind the
 * lazy `loadReportEngine()` import (see `src/lazyChunks.ts`) so neither
 * the pure builders NOR pdf-lib (~150 KB) ever enter the initial bundle.
 */

export type {
  ReportBranding,
  ReportCoverInputs,
  ReportDatasetRow,
  ReportAnnotationRow,
  ReportMeasurementRow,
  ReportInputs,
  ReportProvenanceFingerprint,
  ReportSourceMetadata,
  ReportSourceMetadataField,
  ReportResult,
  ReportSectionId,
  ReportTemplate,
  ReportTemplateId,
  ReportVisualAsset,
} from './types';

export {
  REPORT_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  LEGACY_TEMPLATE_IDS,
  getReportTemplate,
  normalizeReportTemplateId,
} from './ReportTemplates';

export {
  composeReportInputs,
  type ComposeReportInputs,
} from './ReportAssetComposer';
export type { MetadataInputs } from './ReportMetadataSection';

export {
  buildDatasetSummary,
} from './ReportMetadataSection';
export {
  buildAnnotationRows,
} from './ReportAnnotationSection';
export {
  buildMeasurementRows,
} from './ReportMeasurementSection';
export {
  buildInspectionSummary,
} from './ReportFindings';
export type {
  ReportFinding,
  ReportInspectionSummary,
  FindingTier,
} from './ReportFindings';

export {
  DEFAULT_ACCENT,
  parseAccentColor,
  effectiveBranding,
  resolveTheme,
} from './ReportBranding';
export type { ReportThemePalette } from './ReportBranding';

export { generateReport } from './ReportEngine';
export { renderReportPdf } from './ReportPdfRenderer';
