/**
 * ReportEngine.ts
 *
 * Top-level orchestrator. Takes the composer output (a pure `ReportInputs`)
 * + a template id, looks up the template, applies a defensive bounds-check
 * pass, and dispatches to the renderer with a hard timeout so a runaway
 * render (huge annotation list, very long technical notes) can never lock
 * up the calling tab.
 *
 * The renderer itself is responsible for layout; this module's job is to
 * fail fast on inputs that would produce a multi-thousand-page PDF or
 * exceed the browser's pdf-lib memory ceiling, and to bound the render's
 * wall-clock budget.
 */

import type { ReportInputs, ReportResult } from './types';
import { renderReportPdf } from './ReportPdfRenderer';
import { getReportTemplate } from './ReportTemplates';

/** Upper bounds — engineering reports above these are almost always mistakes. */
const MAX_ANNOTATIONS = 2000;
const MAX_MEASUREMENTS = 2000;
const MAX_TECHNICAL_NOTES_BYTES = 200_000;     // ~200 KB of UTF-8 = ~150 pages
const MAX_DATASET_ROWS = 200;
const MAX_VISUALS = 32;
const MAX_ACCEPTANCE_CHECKS = 100;             // 100 user-defined gates is more than any realistic audit needs
const DEFAULT_RENDER_TIMEOUT_MS = 30_000;

/** Optional knobs the caller can override per render. */
export interface GenerateReportOptions {
  /**
   * Hard ceiling on render wall time. Defaults to 30 s — generous for
   * realistic inputs but tight enough that a pathological input can't
   * lock the tab. Set to `Infinity` to disable.
   */
  readonly timeoutMs?: number;
  /**
   * Abort signal the caller can use to cancel mid-render — e.g. wired
   * from a Cancel button. The renderer itself doesn't poll, but the
   * timeout-wrapped engine surface settles with an `AbortError` when
   * the signal fires before the render resolves.
   */
  readonly signal?: AbortSignal;
}

/**
 * Generate a report from a typed `ReportInputs`. Returns the PDF Blob,
 * its page count, and the template id (echoed for the caller's metadata
 * downstream).
 *
 * The function fails fast — with a precise, user-readable message — on
 * any of:
 *   - Unknown template id.
 *   - Annotation / measurement counts above the safety ceiling.
 *   - Technical-notes content above the size ceiling.
 *   - The caller's abort signal already aborted.
 *
 * It also wraps the underlying render in a timeout race so a runaway
 * pdf-lib call (very large visuals, deeply pathological inputs) can't
 * hold the tab indefinitely.
 */
export async function generateReport(
  inputs: ReportInputs,
  options: GenerateReportOptions = {},
): Promise<ReportResult> {
  // ── Template ────────────────────────────────────────────────────────────
  const template = getReportTemplate(inputs.templateId);
  if (!template) {
    throw new Error(
      `Unknown report template id "${inputs.templateId}". ` +
      `Valid ids: engineering-inspection, qa-validation, terrain-review, ` +
      `survey-summary, technical-documentation.`,
    );
  }

  // ── Already-aborted shortcut ────────────────────────────────────────────
  if (options.signal?.aborted) {
    throw new DOMException('Report generation aborted before it started.', 'AbortError');
  }

  // ── Defensive input bounds ──────────────────────────────────────────────
  if (inputs.annotations.length > MAX_ANNOTATIONS) {
    throw new Error(
      `Report would include ${inputs.annotations.length} annotations ` +
      `(cap: ${MAX_ANNOTATIONS}). Filter the annotation set before generating.`,
    );
  }
  if (inputs.measurements.length > MAX_MEASUREMENTS) {
    throw new Error(
      `Report would include ${inputs.measurements.length} measurements ` +
      `(cap: ${MAX_MEASUREMENTS}). Filter the measurement set before generating.`,
    );
  }
  if (inputs.datasetRows.length > MAX_DATASET_ROWS) {
    throw new Error(
      `Report's dataset summary carries ${inputs.datasetRows.length} rows ` +
      `(cap: ${MAX_DATASET_ROWS}). Trim the metadata block before generating.`,
    );
  }
  if (inputs.visuals.length > MAX_VISUALS) {
    throw new Error(
      `Report would embed ${inputs.visuals.length} visuals ` +
      `(cap: ${MAX_VISUALS}). Pre-rendered Studio exports above this count ` +
      `produce a PDF too large for most viewers.`,
    );
  }
  if ((inputs.acceptanceChecks?.length ?? 0) > MAX_ACCEPTANCE_CHECKS) {
    throw new Error(
      `Acceptance checklist has ${inputs.acceptanceChecks!.length} rows ` +
      `(cap: ${MAX_ACCEPTANCE_CHECKS}). A user-defined audit at this scale ` +
      `belongs in a structured checklist tool, not a one-page PDF report.`,
    );
  }
  if (typeof inputs.technicalNotes === 'string') {
    // UTF-8 worst-case is 4 bytes per character, but counting characters
    // is good enough for a guard rail — the limit is on order-of-magnitude
    // misuse, not byte-perfect bookkeeping.
    if (inputs.technicalNotes.length > MAX_TECHNICAL_NOTES_BYTES) {
      throw new Error(
        `Technical notes are ${inputs.technicalNotes.length} characters ` +
        `(cap: ${MAX_TECHNICAL_NOTES_BYTES}). Move the bulk of the content ` +
        `into a separate document and link to it from the notes section.`,
      );
    }
  }

  // ── Render with a timeout race ──────────────────────────────────────────
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs)) {
    // No timeout requested — straight render.
    return renderReportPdf(inputs, template);
  }

  return await new Promise<ReportResult>((resolve, reject) => {
    // The timeout id is captured so the abort path can clear it; without
    // the clear, the timeout's `reject` would still fire after the abort
    // and re-reject a settled promise (harmless but noisy in tests).
    const timeoutId = setTimeout(() => {
      reject(new Error(
        `Report render exceeded the ${(timeoutMs / 1000).toFixed(0)} s budget. ` +
        `Try a template with fewer sections, or trim annotations / measurements / visuals.`,
      ));
    }, timeoutMs);

    // Wire the caller's abort signal through. A signal fired mid-render
    // won't actually cancel pdf-lib's work — it can't be interrupted — but
    // it does free the engine's pending Promise so the caller's UI can
    // unblock immediately.
    const onAbort = (): void => {
      clearTimeout(timeoutId);
      reject(new DOMException('Report generation aborted.', 'AbortError'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    renderReportPdf(inputs, template).then(
      (result) => {
        clearTimeout(timeoutId);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err) => {
        clearTimeout(timeoutId);
        options.signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** The default template id, exposed for callers that don't pin one. */
export { DEFAULT_TEMPLATE_ID } from './ReportTemplates';
