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

import {
  exportDecision,
  type EvidenceLevel,
  type ExportDecision,
} from './evidenceLevel';

export interface RegistryEntry {
  readonly current: EvidenceLevel;
  readonly required: EvidenceLevel;
  readonly exportAllowed: boolean;
}

/**
 * Mirror of `claim-register.yaml`. Keep in sync — the cross-check test fails if
 * this drifts from the YAML. Nothing here is E4+, so every product below its
 * required level gates to exploratory today.
 */
export const EVIDENCE_REGISTRY: Readonly<Record<string, RegistryEntry>> = {
  'MEAS-DISTANCE': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-AREA': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-HEIGHT': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-ANGLE': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-PROFILE': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'VOL-POINT-SAMPLE': { current: 'E1_UNIT_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'VOL-STOCKPILE': { current: 'E1_UNIT_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'GROUND-FILTER': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'DTM': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'DSM': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'CHM': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'CONTOURS': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'SLOPE-RASTER': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'HILLSHADE': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'VRM-TPI': { current: 'E1_UNIT_VERIFIED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'HOLDOUT-RMSE': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'NVA-VVA': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'QUALITY-LEVEL': { current: 'E1_UNIT_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'CONFIDENCE-OVERLAY': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'EPOCH-ALIGN': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'CHANGE-RASTER': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'CHANGE-VOLUME': { current: 'E1_UNIT_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'UNCERTAINTY-BAND': { current: 'E1_UNIT_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'REPORT-DIGEST': { current: 'E1_UNIT_VERIFIED', required: 'E1_UNIT_VERIFIED', exportAllowed: true },
  'PROVENANCE-INFERENCE': { current: 'E1_UNIT_VERIFIED', required: 'E1_UNIT_VERIFIED', exportAllowed: true },
};

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
