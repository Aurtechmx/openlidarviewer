/**
 * derivedLayerReceipt.ts — the scientific receipt for a DERIVED LAYER.
 *
 * A derived layer (contours today; the other analytical products next) is shown
 * in the 3D scene and can outlive the panel that produced it, so "what produced
 * this, and was the software allowed to claim it" has to travel WITH the layer
 * rather than only with an export. This module is that bridge: analysis result
 * in, receipt out.
 *
 * WHY IT IS BUILT FROM THE EXPORT PROVENANCE PATH. `buildExportProvenance` is
 * already the one place that resolves a run's CRS honesty, coverage, registered
 * methods and evidence verdict from the result, and `analysisRecordFromProvenance`
 * is already the canonical record for it. Re-deriving any of that here would be a
 * second source of truth that could disagree with the exported file about the
 * same run — the exact drift the provenance layer exists to prevent. Every
 * EXPORT-specific option (basename, permit, deliverable purpose) is deliberately
 * left unset: a layer is not a file, and a receipt that named an export permit
 * the layer never had would be an overclaim.
 *
 * Pure and clock-free: `generatedAt` is injected, never read from the wall clock,
 * so a receipt is reproducible and byte-stable for a given run.
 */

import type { AnalyseContoursResult } from '../terrain/contour/analyseContours';
import {
  buildExportProvenance,
  analysisRecordFromProvenance,
} from '../terrain/export/exportProvenance';
import {
  buildScientificReceipt,
  receiptToJson,
  renderReceiptText,
  type ScientificReceipt,
} from './scientificReceipt';

export interface DerivedLayerReceiptInput {
  readonly result: AnalyseContoursResult;
  /**
   * The run's timestamp. REQUIRED and injected — defaulting to `new Date()`
   * would make the receipt (and its digest) differ between two identical runs,
   * which is precisely what a fingerprint must not do.
   */
  readonly generatedAt: Date | string;
  /** The process-gate reason the run was authorised from, when it was gated. */
  readonly authorizationGrantedFrom?: string | null;
}

/** Build the receipt describing the analysis a derived layer came from. */
export function buildDerivedLayerReceipt(input: DerivedLayerReceiptInput): ScientificReceipt {
  const provenance = buildExportProvenance(input.result, {
    generatedAt: input.generatedAt,
  });
  return buildScientificReceipt(analysisRecordFromProvenance(provenance), {
    authorizationGrantedFrom: input.authorizationGrantedFrom ?? null,
  });
}

/**
 * The receipt's identity digest — what a `DerivedLayer.provenanceDigest` holds.
 * Identifies a run; it is not a tamper seal.
 */
export function derivedLayerReceiptDigest(receipt: ScientificReceipt): string {
  return receipt.digest;
}

/** The receipt as canonical JSON, for copy / export / embedding in a report. */
export function derivedLayerReceiptJson(receipt: ScientificReceipt): string {
  return receiptToJson(receipt);
}

/** The receipt as readable text, for a "view receipt" surface. */
export function derivedLayerReceiptText(receipt: ScientificReceipt): string {
  return renderReceiptText(receipt);
}
