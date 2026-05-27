/**
 * ReportEngine.ts
 *
 * Top-level orchestrator. Takes the composer output (a pure `ReportInputs`)
 * + a template id, looks up the template, and dispatches to the renderer.
 *
 * Thin on purpose — the actual work lives in the section builders + the
 * renderer; the engine just wires the dispatch.
 */

import type { ReportInputs, ReportResult } from './types';
import { renderReportPdf } from './ReportPdfRenderer';
import { getReportTemplate } from './ReportTemplates';

/**
 * Generate a report from a typed `ReportInputs`. Returns the PDF Blob,
 * its page count, and the template id (echoed for the caller's metadata
 * downstream). Throws a clear error if the template id is unknown.
 */
export async function generateReport(inputs: ReportInputs): Promise<ReportResult> {
  const template = getReportTemplate(inputs.templateId);
  if (!template) {
    throw new Error(
      `Unknown report template id "${inputs.templateId}". ` +
      `Valid ids: engineering-inspection, qa-validation, terrain-review, ` +
      `survey-summary, technical-documentation.`,
    );
  }
  return renderReportPdf(inputs, template);
}

/** The default template id, exposed for callers that don't pin one. */
export { DEFAULT_TEMPLATE_ID } from './ReportTemplates';
