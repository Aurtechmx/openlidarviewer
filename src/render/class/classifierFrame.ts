/**
 * classifierFrame.ts
 *
 * The classifier's frozen physical (metre) parameter preset and the helper that
 * restates it in a cloud's SOURCE units. This is a LIGHT leaf: it holds the
 * preset numbers and a pure conversion function, and imports only TYPES from
 * `deriveClassification`. The eager classify path (`classifierCues`) imports
 * `classifierParamsForFrame` from here, so the heavy classifier core stays out
 * of the boot bundle.
 *
 * `deriveClassification` imports `V2_PARAMS` / `CURRENT_PARAMS` back from here,
 * so there is one source of truth for the numbers and the preset digest cannot
 * drift from what the conversion scales.
 */

import type { ClassifierParams, DeriveClassificationOptions } from './deriveClassification';

// v2's frozen numeric params (13 fields). Held verbatim by preset 2 so its
// digest never moves; v3 extends this rather than mutating it.
export const V2_PARAMS = Object.freeze({
  vegGreennessMin: 0.06,
  minGroundSupport: 0.5,
  buildingMinSupport: 0.66,
  maxObjectSizeM: 20,
  elevThresholdM: 0.3,
  slope: 0.15,
  groundBandM: 0.5,
  lowVegBandM: 2,
  medVegBandM: 5,
  buildingRoughnessMaxM: 1.5,
  buildingMinHagM: 2.5,
  maxGridDim: 768,
  despikeNeighbourFactor: 1,
});

// v3 = v2 + the structural-verticality rescue's one spatial parameter. The
// `satisfies` check still runs, so a missing/typo'd parameter is a compile error.
export const CURRENT_PARAMS = Object.freeze({
  ...V2_PARAMS,
  structuralNeighborRadiusM: 1.0,
  structuralVerticalityMin: 0.85,
}) satisfies ClassifierParams;

/** The source-unit frame a cloud's coordinates live in. */
export interface ClassifierFrame {
  /** Metres per source horizontal unit (~0.3048 for feet). Default 1. */
  readonly linearUnitToMetres?: number | null;
  /** Metres per source vertical unit. Default = the horizontal factor. */
  readonly verticalUnitToMetres?: number | null;
}

/**
 * Restate the classifier's physical (metre) parameters in the cloud's SOURCE
 * units, so the same physical terrain classifies the same whether its
 * coordinates arrive in metres, feet, or a mix. Horizontal lengths
 * (`maxObjectSizeM`, `structuralNeighborRadiusM`) divide by the horizontal
 * factor; vertical lengths (`elevThresholdM`, the HAG bands, roughness,
 * `buildingMinHagM`) divide by the vertical factor; `slope` is a rise/run ratio,
 * so it scales by their quotient (1 when both axes share a unit). Dimensionless
 * parameters (support fractions, greenness, grid-cell cap, despike multiple)
 * pass through untouched. `cellSizeM` is NOT here: the classifier derives it
 * from the point spacing, already in source units.
 *
 * The production classify path MUST apply this before {@link deriveClassification};
 * the corpus does the per-scene equivalent (`scaleLengthParams`). A frame of all
 * 1s returns the metre defaults unchanged.
 */
export function classifierParamsForFrame(frame: ClassifierFrame): Partial<DeriveClassificationOptions> {
  const lin =
    frame.linearUnitToMetres && frame.linearUnitToMetres > 0 ? frame.linearUnitToMetres : 1;
  const vert =
    frame.verticalUnitToMetres && frame.verticalUnitToMetres > 0 ? frame.verticalUnitToMetres : lin;
  const p = CURRENT_PARAMS;
  return {
    // Carried so the auto cell-size clamp stays physical (see chooseCellSize).
    linearUnitToMetres: lin,
    maxObjectSizeM: p.maxObjectSizeM / lin,
    structuralNeighborRadiusM: p.structuralNeighborRadiusM / lin,
    elevThresholdM: p.elevThresholdM / vert,
    groundBandM: p.groundBandM / vert,
    lowVegBandM: p.lowVegBandM / vert,
    medVegBandM: p.medVegBandM / vert,
    buildingRoughnessMaxM: p.buildingRoughnessMaxM / vert,
    buildingMinHagM: p.buildingMinHagM / vert,
    slope: p.slope * (lin / vert),
  };
}
