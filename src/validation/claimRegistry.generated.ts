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
  /** Parameter sets the claim's supporting studies cover (scope.supported); absent when none are declared. */
  readonly scopedParameterSets?: readonly string[];
}

export const EVIDENCE_REGISTRY: Readonly<Record<string, RegistryEntry>> = {
  'MEAS-DISTANCE': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-AREA': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'E57-INGEST': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-HEIGHT': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-BOX': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-ANGLE': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'MEAS-PROFILE': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'CRS-UTM-PROJECTION': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'VOL-POINT-SAMPLE': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'VOL-STOCKPILE': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'GROUND-FILTER': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'DTM': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-DTM-MIN-CELL1-R045', 'PS-DTM-MEDIAN-CELL1-ORIGIN0', 'PS-DTM-MEDIAN-CELL0P25-ORIGINMIN', 'PS-DTM-MEDIAN-CELL0P5-ORIGINMIN', 'PS-DTM-MEDIAN-CELL2-ORIGINMIN', 'PS-DTM-MEDIAN-CELL5-ORIGINMIN'] },
  'DSM': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-DSM-MAX-CELL1-R045'] },
  'CHM': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-CHM-DIFF-CELL1-R045'] },
  'CONTOURS': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'CONTOURS-CARTOGRAPHIC': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true },
  'SLOPE-RASTER': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-HORN-DEG-METRE-NOEDGES'] },
  'ASPECT-RASTER': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-HORN-COMPASS-METRE-NOEDGES'] },
  'HILLSHADE': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-HORN-HILLSHADE-AZ315-ALT45'] },
  'TPI': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-TPI-MOORE-QUADRATIC'] },
  'VRM': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-VRM-3X3-TILTED'] },
  'HOLDOUT-RMSE': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-ACCURACY-POOLED-RMSE'] },
  'NVA-VVA': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-ACCURACY-NVA95'] },
  'VVA-P95': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'QUALITY-LEVEL': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'CONFIDENCE-OVERLAY': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'EPOCH-ALIGN': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'CHANGE-RASTER': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-CHANGE-LOD-005-CELL-1M'] },
  'CHANGE-VOLUME': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-CHANGE-LOD-005-CELL-1M'] },
  'UNCERTAINTY-BAND': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E5_EXTERNALLY_VALIDATED', exportAllowed: true },
  'REPORT-DIGEST': { current: 'E1_UNIT_VERIFIED', required: 'E1_UNIT_VERIFIED', exportAllowed: true },
  'PROVENANCE-INFERENCE': { current: 'E1_UNIT_VERIFIED', required: 'E1_UNIT_VERIFIED', exportAllowed: true },
  'ORG-TOPOLOGY-IDENTITY': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E3_SYNTHETICALLY_VALIDATED', exportAllowed: false },
  'ORG-RANGE-GEOMETRIC': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E2_ANALYTICALLY_VERIFIED', exportAllowed: false },
  'ORG-PTX-SETUP-TOPOLOGY': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E3_SYNTHETICALLY_VALIDATED', exportAllowed: false },
  'ORG-PCD-ORGANIZATION': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E3_SYNTHETICALLY_VALIDATED', exportAllowed: false },
  'TERRAIN-FLOW-PULSE': { current: 'E4_CROSS_IMPLEMENTATION_VALIDATED', required: 'E4_CROSS_IMPLEMENTATION_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-FLOW-PRIORITY-FLOOD-NODATA-OUTLET', 'PS-FLOW-PRIORITY-FLOOD-NODATA-WALL', 'PS-FLOW-D8-RAW-25M', 'PS-FLOW-D8-CONDITIONED-OUTLET-25M'] },
  'TERRAIN-FLOW-DEPRESSION-INVENTORY': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E3_SYNTHETICALLY_VALIDATED', exportAllowed: true, scopedParameterSets: ['PS-FLOW-PRIORITY-FLOOD-NODATA-OUTLET'] },
  'TERRAIN-FLOW-RATIONAL-PEAK': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E2_ANALYTICALLY_VERIFIED', exportAllowed: true },
  'TERRAIN-ACCESS': { current: 'E3_SYNTHETICALLY_VALIDATED', required: 'E3_SYNTHETICALLY_VALIDATED', exportAllowed: true },
  'STORAGE-HISTORY': { current: 'E2_ANALYTICALLY_VERIFIED', required: 'E2_ANALYTICALLY_VERIFIED', exportAllowed: true },
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
  | 'MEAS-BOX'
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
  | 'VVA-P95'
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
  | 'TERRAIN-FLOW-DEPRESSION-INVENTORY'
  | 'TERRAIN-FLOW-RATIONAL-PEAK'
  | 'TERRAIN-ACCESS'
  | 'STORAGE-HISTORY';
