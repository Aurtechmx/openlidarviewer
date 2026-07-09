/**
 * exportEvidenceNote.ts
 *
 * ONE evidence note for any export product, DERIVED from the single evidence
 * gate (`exportGate` over the runtime registry) rather than asserted. Before
 * this, only the terrain/DTM path consulted the gate; the map sheet, the
 * measurement GeoJSON/CSV, the space/object report and the integrity report all
 * shipped with no gate verdict at all. This gives every exporter one place to
 * ask "what may I claim for this product?" and get a stamp whose wording matches
 * the gate decision — so a below-threshold product can never leave the app
 * reading as a validated deliverable.
 *
 * The DECISION comes from one resolver (`exportGate`); the phrasing here is
 * product-neutral so any exporter can use it. (The terrain export path keeps its
 * own terrain-specific wording; both derive the same verdict from the same gate.)
 *
 * Pure data. No DOM, no I/O.
 */

import { exportGate } from './evidenceRegistry';

/**
 * The evidence note for a product identified by its claim id. Derived from the
 * gate: exploratory when below the required level, validated when it meets it,
 * and an explicit refusal when the product is not exportable at all.
 */
export function evidenceNote(claimId: string): string {
  const d = exportGate(claimId);
  if (d.exploratoryOnly) {
    return (
      'Evidence: exploratory export — this product is below its required evidence ' +
      'level (not cross-validated against an independent implementation, and not ' +
      'field-validated). Do not present it as a validated deliverable.'
    );
  }
  if (d.allowed) {
    return 'Evidence: validated export — this product meets its required evidence level.';
  }
  return 'Evidence: export refused — this product is not exportable at its current evidence level.';
}

/** True when the product may only leave the app as an exploratory artifact. */
export function isExploratoryExport(claimId: string): boolean {
  return exportGate(claimId).exploratoryOnly;
}

/**
 * The compact, machine-friendly claim status for a product — the SAME gate
 * verdict as {@link evidenceNote}, reduced to one token so an exporter that has
 * no room for a full sentence (a CSV cell, a PDF collar, a JSON status field)
 * can still stamp the honest status. Never promotes: a below-threshold product
 * is `exploratory`, a not-exportable product is `refused`, and only a product
 * that genuinely meets its required level is `validated`.
 */
export type EvidenceStatus = 'validated' | 'exploratory' | 'refused';

export function evidenceStatus(claimId: string): EvidenceStatus {
  const d = exportGate(claimId);
  if (d.exploratoryOnly) return 'exploratory';
  if (d.allowed) return 'validated';
  return 'refused';
}
