/**
 * ReportTemplates.ts
 *
 * The five built-in report templates. Each is a pure-data record:
 * id, label, description, ordered list of sections.
 *
 * Templates are EXTENSIBLE — adding a sixth template (or letting users
 * author custom ones) is a one-entry addition to `REPORT_TEMPLATES`.
 * The renderer dispatches on `section`, not on template id, so new
 * templates compose existing sections without renderer changes.
 *
 * Pure of pdf-lib + DOM; tests run in Node.
 */

import type { ReportTemplate, ReportTemplateId } from './types';

const engineeringInspection: ReportTemplate = {
  id: 'engineering-inspection',
  label: 'Engineering Inspection',
  description:
    'Full inspection record: cover + dataset metadata + measurements + ' +
    'annotations + visuals + technical notes. Use for as-built reviews ' +
    'and structural-defect documentation.',
  sections: [
    'cover',
    'dataset-summary',
    'measurements',
    'annotations',
    'visuals',
    'technical-notes',
    'footer',
  ],
};

const qaValidation: ReportTemplate = {
  id: 'qa-validation',
  label: 'QA Validation',
  description:
    'QA-focused: cover, dataset summary, classification/intensity visuals, ' +
    'annotations (flagged issues). Skips measurements + notes. Compact, ' +
    'ships in 2–3 pages typically.',
  sections: ['cover', 'dataset-summary', 'visuals', 'annotations', 'footer'],
};

const terrainReview: ReportTemplate = {
  id: 'terrain-review',
  label: 'Terrain Review',
  description:
    'Topographic review: cover, dataset summary, height map + contour ' +
    'visuals, measurements (slope/distance), footer. No annotations.',
  sections: ['cover', 'dataset-summary', 'visuals', 'measurements', 'footer'],
};

const surveySummary: ReportTemplate = {
  id: 'survey-summary',
  label: 'Survey Summary',
  description:
    'Cover, dataset metadata, all measurements, technical notes. Skips ' +
    'visuals + annotations — for handover documents where the source scan ' +
    'travels alongside.',
  sections: ['cover', 'dataset-summary', 'measurements', 'technical-notes', 'footer'],
};

const technicalDocumentation: ReportTemplate = {
  id: 'technical-documentation',
  label: 'Technical Documentation',
  description:
    'Everything: cover, dataset summary, all visuals, all measurements + ' +
    'annotations, free-form notes. Use for the canonical archived record.',
  sections: [
    'cover',
    'dataset-summary',
    'visuals',
    'measurements',
    'annotations',
    'technical-notes',
    'footer',
  ],
};

/**
 * Scan Acceptance template. A user-supplied-threshold pass/fail sheet
 * for incoming-scan validation. Metadata-only rows in the current
 * release; the cloud-sampled rows (density, void map, NPS, RMSE) land
 * once the analysis seam is online. The Methods appendix cites Lohani
 * & Ghosh 2017 (peer-reviewed Springer survey) as the source for the
 * USGS-style metrics this template will encode over time.
 */
const scanAcceptance: ReportTemplate = {
  id: 'scan-acceptance',
  label: 'Scan Acceptance',
  description:
    'A pass/fail QA sheet against thresholds you supply. The viewer ' +
    'reports what was measured; the thresholds are yours. Use it to sign ' +
    'off (or reject) an incoming scan delivery — every check carries a ' +
    'literature citation in the Methods appendix.',
  sections: ['cover', 'dataset-summary', 'acceptance-checklist', 'footer'],
};

/** The full template catalogue, in display order. */
export const REPORT_TEMPLATES: readonly ReportTemplate[] = [
  engineeringInspection,
  qaValidation,
  terrainReview,
  surveySummary,
  technicalDocumentation,
  scanAcceptance,
];

/** Look up a template by id, or `undefined` if unknown. */
export function getReportTemplate(id: ReportTemplateId): ReportTemplate | undefined {
  return REPORT_TEMPLATES.find((t) => t.id === id);
}

/**
 * The default template — used when the caller doesn't specify one. Picked
 * to be the most generally useful: Engineering Inspection covers the
 * canonical "drone LiDAR → as-built" workflow.
 */
export const DEFAULT_TEMPLATE_ID: ReportTemplateId = 'engineering-inspection';
