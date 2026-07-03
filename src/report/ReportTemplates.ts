/**
 * ReportTemplates.ts
 *
 * The two built-in report templates. Each is a pure-data record:
 * id, label, description, ordered list of sections.
 *
 * v0.5.5 P12 — consolidated from the previous six-template catalogue.
 * Verified evidence (real exports of the same dataset): four of the six
 * templates emitted ~85 % byte-identical content — identical Inspection
 * summary, Dataset summary, Provenance, Signals and Expected-accuracy
 * sections — differing only in which trailing stubs appeared, and no
 * template contained content matching its title (QA Validation had no
 * checks; Technical Documentation had no methods appendix). The catalogue
 * is now two templates whose section sets are genuinely distinct:
 *
 *   - `survey-summary`   — the compact handover document.
 *   - `technical-report` — the complete archived record.
 *
 * Legacy ids parse safely via `normalizeReportTemplateId` (see
 * `LEGACY_TEMPLATE_IDS`), each mapping to the nearest new template, so
 * saved sessions / external callers keep working.
 *
 * Templates are EXTENSIBLE — adding a third template (or letting users
 * author custom ones) is a one-entry addition to `REPORT_TEMPLATES`.
 * The renderer dispatches on `section`, not on template id, so new
 * templates compose existing sections without renderer changes.
 *
 * Pure of pdf-lib + DOM; tests run in Node.
 */

import type { ReportTemplate, ReportTemplateId } from './types';

const surveySummary: ReportTemplate = {
  id: 'survey-summary',
  label: 'Survey Summary',
  description:
    'Compact handover document: cover, inspection summary, dataset ' +
    'metadata (CRS/units), capture-type provenance, all measurements, ' +
    'technical notes when provided. For deliveries where the source scan ' +
    'travels alongside.',
  sections: [
    'cover',
    'inspection-summary',
    'dataset-summary',
    // Compact provenance: capture type + confidence + disclaimer only.
    // The signal list and the literature-cited accuracy bounds are
    // Technical Report material — the summary names the capture type
    // without restating the full evidence chain.
    'provenance-compact',
    'measurements',
    'technical-notes',
    'footer',
  ],
};

const technicalReport: ReportTemplate = {
  id: 'technical-report',
  label: 'Technical Report',
  description:
    'The complete record: everything in Survey Summary plus the full ' +
    'provenance detail (classifier signals + expected accuracy with cited ' +
    'literature), the file\'s own declared source metadata, annotations ' +
    'and visuals. Use for the canonical archived deliverable.',
  sections: [
    'cover',
    'inspection-summary',
    'dataset-summary',
    // Full provenance: capture type + signals + literature-cited bounds.
    'provenance',
    // The file's own declared metadata (verbatim, "declared, not verified")
    // reads directly after the heuristic provenance so the two provenance
    // sources sit side by side. Omitted entirely when nothing is declared.
    'source-metadata',
    'measurements',
    'annotations',
    'visuals',
    'technical-notes',
    'footer',
  ],
};

/** The full template catalogue, in display order. */
export const REPORT_TEMPLATES: readonly ReportTemplate[] = [
  surveySummary,
  technicalReport,
];

/**
 * Retired template ids and the nearest new template each maps to.
 * Sessions, prefs, bookmarks or callers that still carry a legacy id keep
 * working — they get the closest current template instead of an error.
 *
 *  - qa-validation / engineering-inspection / technical-documentation:
 *    members of the ~85 %-identical family — the complete record is the
 *    honest replacement.
 *  - terrain-review: a strict section-subset of the same shared core.
 *  - scan-acceptance: retired with this consolidation. Its checklist was
 *    metadata-only presence rows — the same title-overpromising defect
 *    this change removes. It returns behind real cloud-sampled checks
 *    once the analysis seam lands.
 */
export const LEGACY_TEMPLATE_IDS: Readonly<Record<string, ReportTemplateId>> = {
  'engineering-inspection': 'technical-report',
  'qa-validation': 'technical-report',
  'technical-documentation': 'technical-report',
  'terrain-review': 'technical-report',
  'scan-acceptance': 'technical-report',
};

/**
 * Resolve any template id — current or legacy — to a current one.
 * Returns `undefined` for genuinely unknown ids so callers can decide
 * between throwing (engine) and falling back (UI).
 */
export function normalizeReportTemplateId(id: string): ReportTemplateId | undefined {
  if (REPORT_TEMPLATES.some((t) => t.id === id)) return id as ReportTemplateId;
  return LEGACY_TEMPLATE_IDS[id];
}

/** Look up a template by id (legacy ids resolve to their replacement). */
export function getReportTemplate(id: string): ReportTemplate | undefined {
  const normalized = normalizeReportTemplateId(id);
  return REPORT_TEMPLATES.find((t) => t.id === normalized);
}

/**
 * The default template — used when the caller doesn't specify one. The
 * complete record covers the canonical "drone LiDAR → as-built" workflow
 * (the old Engineering Inspection default maps here too).
 */
export const DEFAULT_TEMPLATE_ID: ReportTemplateId = 'technical-report';
