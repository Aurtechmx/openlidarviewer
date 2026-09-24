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
  'MEAS-DISTANCE': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-AREA': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'E57-INGEST': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-HEIGHT': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-ANGLE': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-PROFILE': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'CRS-UTM-PROJECTION': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'VOL-POINT-SAMPLE': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'VOL-STOCKPILE': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'GROUND-FILTER': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'DTM': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'DSM': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'CHM': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'CONTOURS': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'CONTOURS-CARTOGRAPHIC': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'SLOPE-RASTER': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'ASPECT-RASTER': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'HILLSHADE': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'TPI': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'VRM': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'HOLDOUT-RMSE': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'NVA-VVA': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'QUALITY-LEVEL': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'CONFIDENCE-OVERLAY': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'EPOCH-ALIGN': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'CHANGE-RASTER': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'CHANGE-VOLUME': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'UNCERTAINTY-BAND': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'REPORT-DIGEST': { current: 'E1_UNIT_VERIFIED', required: 'E1_UNIT_VERIFIED', exportAllowed: true },
  'PROVENANCE-INFERENCE': { current: 'E1_UNIT_VERIFIED', required: 'E1_UNIT_VERIFIED', exportAllowed: true },
  'ORG-TOPOLOGY-IDENTITY': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E3_SYNTHETICALLY_VALIDATED', exportAllowed: false },
  'ORG-RANGE-GEOMETRIC': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E2_ANALYTICALLY_VERIFIED', exportAllowed: false },
  'ORG-PTX-SETUP-TOPOLOGY': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E3_SYNTHETICALLY_VALIDATED', exportAllowed: false },
  'ORG-PCD-ORGANIZATION': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E3_SYNTHETICALLY_VALIDATED', exportAllowed: false },
  'TERRAIN-FLOW-PULSE': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'TERRAIN-FLOW-DEPRESSION-INVENTORY': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E3_SYNTHETICALLY_VALIDATED', exportAllowed: true },
};

/**
 * Every registered claim id, as a type.
 *
 * The ids were plain `string` everywhere, so the ~35 literals that do not sit
 * inside an `exportGate(...)` call — export manifests, cross-check reference
 * slots, module constants — were invisible to `lint:claim-register`, whose
 * regex matches one call shape. A rename in the YAML would have been caught
 * for the gate calls and missed for the rest. Typed, every one of them is a
 * compile error instead.
 */
export type ClaimId =
  | 'MEAS-DISTANCE'
  | 'MEAS-AREA'
  | 'E57-INGEST'
  | 'MEAS-HEIGHT'
  | 'MEAS-ANGLE'
  | 'MEAS-PROFILE'
  | 'CRS-UTM-PROJECTION'
  | 'VOL-POINT-SAMPLE'
  | 'VOL-STOCKPILE'
  | 'GROUND-FILTER'
  | 'DTM'
  | 'DSM'
  | 'CHM'
  | 'CONTOURS'
  | 'CONTOURS-CARTOGRAPHIC'
  | 'SLOPE-RASTER'
  | 'ASPECT-RASTER'
  | 'HILLSHADE'
  | 'TPI'
  | 'VRM'
  | 'HOLDOUT-RMSE'
  | 'NVA-VVA'
  | 'QUALITY-LEVEL'
  | 'CONFIDENCE-OVERLAY'
  | 'EPOCH-ALIGN'
  | 'CHANGE-RASTER'
  | 'CHANGE-VOLUME'
  | 'UNCERTAINTY-BAND'
  | 'REPORT-DIGEST'
  | 'PROVENANCE-INFERENCE'
  | 'ORG-TOPOLOGY-IDENTITY'
  | 'ORG-RANGE-GEOMETRIC'
  | 'ORG-PTX-SETUP-TOPOLOGY'
  | 'ORG-PCD-ORGANIZATION'
  | 'TERRAIN-FLOW-PULSE'
  | 'TERRAIN-FLOW-DEPRESSION-INVENTORY';
