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

import { exportGate, EVIDENCE_REGISTRY } from './evidenceRegistry';
import { evidenceRank, INDEPENDENCE_FLOOR } from './evidenceLevel';
import {
  resolveEvidence,
  type EvidenceContext,
  type ScopedEvidenceRecord,
} from './scopedEvidence';

/**
 * The evidence note for a product identified by its claim id. Derived from the
 * gate: exploratory when below the required level, validated when it meets it,
 * and an explicit refusal when the product is not exportable at all.
 */
export function evidenceNote(claimId: string): string {
  const d = exportGate(claimId);
  if (d.exploratoryOnly) {
    // A product can be exploratory for two different reasons, and conflating
    // them understates the evidence: it may sit below the independence floor
    // (genuinely not cross-validated), or it may be cross-implementation
    // validated (E4) yet still below a higher required level (E5 field). Name
    // the real reason from the product's current level.
    const current = EVIDENCE_REGISTRY[claimId]?.current;
    const crossValidated =
      current != null && evidenceRank(current) >= evidenceRank(INDEPENDENCE_FLOOR);
    return crossValidated
      ? (
        'Evidence: exploratory export — this product is cross-implementation ' +
        'validated against an independent implementation, but below its required ' +
        'level (not field-validated against ground control). Do not present it ' +
        'as a validated deliverable.'
      )
      : (
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

/**
 * A caveat for a measurement product whose linear scale is UNVERIFIED — a scan
 * with no known CRS unit, where the render-space geometry is real but its metre
 * labelling is a guess (the factor is an inert 1). Appended to the product's
 * evidence note so a length in the file never silently asserts metres it can't
 * back (pass-6 M1). Empty when the scale is known, so a georeferenced export is
 * byte-identical to before.
 */
export function unverifiedUnitsCaveat(unitsVerified: boolean): string {
  if (unitsVerified) return '';
  return (
    ' Units unverified: this scan has no known CRS scale, so lengths, areas and ' +
    'volumes are in the source render units — treat the metre labels as nominal, ' +
    'not confirmed metres.'
  );
}

export function evidenceStatus(claimId: string): EvidenceStatus {
  const d = exportGate(claimId);
  if (d.exploratoryOnly) return 'exploratory';
  if (d.allowed) return 'validated';
  return 'refused';
}

/**
 * The SCOPE-AWARE evidence note for a DTM-family product, derived from
 * {@link resolveEvidence}. Compact, and never shows a bare "E5": an in-scope
 * match reads as validated FOR the registered study envelope; an out-of-scope or
 * applicability-unknown result says external evidence exists but this dataset is
 * outside the validated scope. With no context (or no scoped record), the wording
 * matches the baseline note the product already carries.
 *
 * `records` defaults to the empty shipped set, so with today's registry this
 * returns the baseline wording for every real artifact.
 */
export function scopedEvidenceNote(
  claimId: string,
  context?: EvidenceContext,
  records?: readonly ScopedEvidenceRecord[],
): string {
  const r = resolveEvidence(claimId, context, records);
  switch (r.resolutionState) {
    case 'validated-in-scope':
      return (
        'Evidence: externally field validated for the registered study envelope ('
        + r.matchedScopedStudy + '). Applies only within that scope.'
      );
    case 'external-evidence-out-of-scope':
      return (
        'Evidence: external field evidence exists for this DTM method, but this '
        + 'dataset is outside the validated study scope. Baseline level stands.'
      );
    case 'applicability-unknown':
      return (
        'Evidence: external field evidence exists for this DTM method, but this '
        + 'dataset’s applicability could not be established, so it is treated '
        + 'as outside the validated study scope. Baseline level stands.'
      );
    default:
      // No scoped record for the claim: the baseline gate note is authoritative.
      return evidenceNote(claimId);
  }
}
