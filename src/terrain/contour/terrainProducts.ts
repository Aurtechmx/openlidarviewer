/**
 * terrainProducts.ts
 *
 * The "Terrain Products" status list — a VIEW, not an engine. It re-presents
 * the verdicts {@link recommendedWorkflows} already graded (which in turn are
 * a pure projection of {@link TerrainAssessment}) as the compact per-product
 * list the Analyse panel leads with: one row per product, a Ready / Preview /
 * Blocked word, a ✓ / ⚠ / ✕ glyph, and — for non-ready rows only — a full,
 * specific reason (a Ready row needs no excuse).
 *
 * NO NEW LOGIC lives here by contract: every status is the workflow row's
 * status renamed through the readiness engine's own vocabulary tables
 * (statusWordFor: good → Ready, caution → Preview, blocked → Blocked;
 * glyphFor: ✓ / ⚠ / ✕) and every reason is selected by the engine's own
 * {@link productReasonFor} among strings the assessment engines already
 * minted (`TerrainAssessment.reason` — the line that quotes the measured
 * figures, `.exportReason` — the line that names the georef gap, or the
 * `WorkflowItem.note`). If this module ever disagrees with the detail
 * checklist, that is a bug here — the engines stay the single source of truth.
 *
 * Pure data, deterministic, unit-tested; the DOM half lives in
 * `ui/workflowCardRender.ts` (`renderTerrainProducts`).
 */

import type { TerrainAssessment } from './terrainAssessment';
import type { WorkflowItem } from './recommendedWorkflow';
import {
  statusWordFor,
  glyphFor,
  productReasonFor,
  type ReadinessTier,
} from '../quality/readinessEngine';

/** The product-status word — the deliverable vocabulary, not the grade one. */
export type ProductStatusWord = ReadinessTier;

/** One row of the Terrain Products list. */
export interface TerrainProduct {
  /** Product name, e.g. 'Profiles', 'DTM/DEM export'. */
  readonly label: string;
  /** Style hook: ready | preview | blocked (mirrors the workflow grade). */
  readonly status: 'ready' | 'preview' | 'blocked';
  /** The textual verdict — carried as TEXT so the row is never colour-only. */
  readonly statusWord: ProductStatusWord;
  /** ✓ / ⚠ / ✕, decorative beside the status word. */
  readonly glyph: '✓' | '⚠' | '✕';
  /**
   * The full, specific reason the product sits below Ready — selected by the
   * readiness engine ({@link productReasonFor}) among assessment-minted
   * strings, quoting the measured figure where one backs the verdict (e.g.
   * "50% of the surface is interpolated"). ABSENT for Ready rows: a ready
   * product needs no excuse. Render it whole — never truncated.
   */
  readonly reason?: string;
}

/**
 * Workflow label → product label. The workflow checklist speaks in verbs
 * ("Profile analysis"); the products list speaks in deliverables
 * ("Profiles"). An unmapped row keeps its own label so a future workflow
 * appears rather than silently vanishing.
 */
const PRODUCT_LABEL: Readonly<Record<string, string>> = {
  'Profile analysis': 'Profiles',
  'Measurement review': 'Measurements',
  'Surface sampling / inspection': 'Terrain review',
  'DEM export': 'DTM/DEM export',
  'Contour generation': 'Contours',
  'Map sheet (PDF)': 'Map sheet',
};

/** Deliverable-class workflows — their fallback reason is the EXPORT axis. */
const DELIVERABLE_LABELS: ReadonlySet<string> = new Set([
  'DEM export',
  'Contour generation',
  'Map sheet (PDF)',
]);

// The grade → word / glyph vocabulary lives in the readiness engine
// (statusWordFor / glyphFor) — the SAME tables every other verdict view
// renders from. Only the style-hook rename (good → ready, …) is local,
// because it is this view's own CSS vocabulary, not verdict grammar.
const STATUS_KEY: Record<WorkflowItem['status'], TerrainProduct['status']> = {
  good: 'ready',
  caution: 'preview',
  blocked: 'blocked',
};

/**
 * Project the graded workflow checklist onto the Terrain Products rows.
 *
 * Reason resolution is the ENGINE's ({@link productReasonFor} — existing
 * strings only, most specific first): good rows carry none; inspection rows
 * quote the surface-quality line (with its measured figures); deliverable
 * rows quote the export reason when georeferencing is the gap, the
 * figure-quoting surface line when the surface itself is, and fall back to
 * the workflow row's own note last.
 */
export function terrainProducts(
  assessment: TerrainAssessment,
  workflows: ReadonlyArray<WorkflowItem>,
): TerrainProduct[] {
  return workflows.map((w) => {
    const reason = productReasonFor({
      status: w.status,
      productClass: DELIVERABLE_LABELS.has(w.label) ? 'deliverable' : 'inspection',
      surfaceTier: assessment.status,
      surfaceReason: assessment.reason,
      exportReason: assessment.exportReason,
      ...(w.note != null ? { note: w.note } : {}),
    });
    return {
      label: PRODUCT_LABEL[w.label] ?? w.label,
      status: STATUS_KEY[w.status],
      statusWord: statusWordFor(w.status),
      glyph: glyphFor(w.status),
      ...(reason != null ? { reason } : {}),
    };
  });
}
