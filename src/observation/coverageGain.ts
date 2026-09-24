/**
 * coverageGain.ts — Coverage Gain instrument-model and term contract
 * (docs/observatory/SPEC.md §5.6, OB-GAIN-01..03, OB-GAIN-05).
 *
 * NOT IMPLEMENTED. `olv.observation.coverage-gain` is registered ahead of
 * phase O10, which generates candidates and scores them against a real
 * ledger. This file names only the declared instrument model (OB-GAIN-01)
 * and per-candidate term shapes (OB-GAIN-03) SPEC already fixes; the greedy
 * multi-station search sits in `stationSuggestion.ts`, a distinct method id
 * (OB-GAIN-04).
 *
 * Pure and DOM-free (OB-INT-01). No candidate generation, no gain scoring and
 * no manufacturer table lookup is implemented here or anywhere yet — SPEC
 * states plainly that none is consulted (OB-GAIN-01).
 */

/**
 * The instrument model a user declares before Coverage Gain runs
 * (OB-GAIN-01). Recorded in full with the run; nothing here is looked up from
 * a manufacturer table.
 */
export interface ObservationInstrumentModel {
  /** Metres above the standing surface a candidate station is placed at. */
  readonly heightAboveSurface: number;
  readonly minRange: number;
  readonly maxRange: number;
  readonly verticalFieldOfViewDegrees: number;
  /** Angular step used for planning rays, in degrees. */
  readonly angularStepDegrees: number;
  /** When set, copies this source's declared or fitted parameters instead. */
  readonly sameAsSourceIndex: number | null;
}

/**
 * OB-GAIN-03's per-candidate gain terms, every one reported separately rather
 * than only the sum: `G(c) = Σ w(state)·vis·inc − λ_red·redundant`.
 */
export interface CandidateGainTerms {
  readonly candidateIndex: number;
  readonly weightedVisibilitySum: number;
  readonly redundantPenalty: number;
  readonly gain: number;
  /** Voxels the candidate cannot address at all (e.g. `NOT_READ`, weight 0). */
  readonly excludedVoxelCount: number;
}

/** OB-GAIN-03's declared default per-state weights (`w`), before redundancy. */
export const DEFAULT_GAIN_STATE_WEIGHTS = {
  SHADOWED: 1.0,
  UNADDRESSED: 1.0,
  NO_RETURN_PATH: 0.25,
  CONFLICT: 0.5,
  /** Weak `SURFACE`: strength components below declared floors. */
  WEAK_SURFACE: 0.5,
} as const;
