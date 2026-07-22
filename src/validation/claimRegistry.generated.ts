/**
 * claimRegistry.generated.ts — AUTO-GENERATED. DO NOT EDIT.
 *
 * Generated from docs/validation/claim-register.yaml by
 * scripts/generate-claim-registry.mjs. Edit the YAML and run
 * `npm run gen:claim-registry`. lint:claim-register fails on drift.
 */
import type { EvidenceLevel } from './evidenceLevel';

export interface RegistryEntry {
  readonly current: EvidenceLevel;
  readonly required: EvidenceLevel;
  readonly exportAllowed: boolean;
}

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
  'SLOPE-RASTER': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
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
