/**
 * evidenceRegistry.ts
 *
 * The RUNTIME evidence registry: the machine-readable claim register
 * (`docs/validation/claim-register.yaml`) mirrored as typed code so the export
 * paths can actually consult it, rather than the register being documentation
 * the running app never reads (the gap the external audit flagged).
 *
 * Every entry carries its current and required evidence level and whether it may
 * be exported at all. `exportGate(claimId)` turns that into an
 * {@link ExportDecision}: a product below its required level is exportable only
 * as an explicitly watermarked *exploratory* artifact; a product marked not
 * exportable is refused entirely; an unknown claim id is refused (treated as
 * `E0` / unregistered per the evidence model).
 *
 * Drift guard: `tests/evidenceRegistry.test.ts` parses the YAML register and
 * asserts this map matches it entry for entry, so editing one without the other
 * fails CI.
 *
 * Pure data, deterministic. No DOM, no I/O.
 */

import { exportDecision, type ExportDecision } from './evidenceLevel';
// The registry is GENERATED from docs/validation/claim-register.yaml by
// scripts/generate-claim-registry.mjs (`npm run gen:claim-registry`), so it can
// never be hand-mirrored out of sync. lint:claim-register fails on any drift.
import { EVIDENCE_REGISTRY, type RegistryEntry } from './claimRegistry.generated';

export { EVIDENCE_REGISTRY };
export type { RegistryEntry };

/**
 * Resolve the export decision for a product by its claim id. An unknown id is
 * refused as a validated export (unregistered ⇒ E0 ⇒ exploratory-only with a
 * clear reason), never silently allowed.
 */
export function exportGate(claimId: string): ExportDecision {
  const entry = EVIDENCE_REGISTRY[claimId];
  if (!entry) {
    return {
      allowed: false,
      exploratoryOnly: true,
      reason: `No evidence-register entry for "${claimId}"; treated as unregistered (E0) and exportable only as exploratory.`,
    };
  }
  return exportDecision(entry.current, entry.required, entry.exportAllowed);
}

/** True when the product meets its required level and needs no exploratory mark. */
export function isValidatedExport(claimId: string): boolean {
  const d = exportGate(claimId);
  return d.allowed && !d.exploratoryOnly;
}
