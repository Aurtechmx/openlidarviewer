/**
 * stationSuggestion.ts — `olv.observation.station-suggestion`
 * (docs/observatory/SPEC.md §5.6, OB-GAIN-04, OB-GAIN-06, OB-INV-05). Phase O10.
 *
 * Greedy sequential selection over Coverage Gain candidates
 * (`coverageGain.ts`). After a station is picked, the voxels its planning
 * rays reach are added to a hypothetical `covered` set, a copy that stands in
 * for "the ledger as if this station had scanned"; every remaining
 * candidate is re-scored against it. The canonical ledger rows and state map
 * are only read, never written, and a suggested station never becomes a
 * source (OB-INV-05).
 *
 * A candidate's visible voxel set does not depend on `covered` (blocking is
 * decided by the canonical `SURFACE`/`PARTIAL` states), so visibility is
 * traced once per candidate and each round only re-scores.
 *
 * OB-GAIN-06 defines only the {@link ReachabilityProvider} interface for
 * v0.7; there is no implementation, and no "reachable" mode is offered.
 *
 * Pure and DOM-free (OB-INT-01).
 */
import {
  generateCandidates,
  planningAuthority,
  planningDirections,
  resolveInstrumentModel,
  scoreCandidate,
  traceCandidateVisibility,
  type CandidateGainTerms,
  type CandidateVisibility,
  type CoverageCandidate,
  type CoverageGainParameters,
  type DeclaredSourceInstrument,
  type ObservationInstrumentModel,
  type PlanningAuthorityVerdict,
  type PlanningField,
} from './coverageGain';

/** OB-GAIN-06's three verdicts. Never a boolean: `unknown` is a real answer. */
export type ReachabilityVerdict = 'reachable' | 'unreachable' | 'unknown';

/**
 * OB-GAIN-06: the only piece of Terrain Access this spec defines for v0.7.
 * A verdict without an implementation to back it would be worse than no
 * verdict at all, so every one carries what grounds it.
 */
export interface ReachabilityProvider {
  verdictAt(worldPosition: readonly [number, number, number]): {
    readonly verdict: ReachabilityVerdict;
    readonly evidenceRef: string;
  };
}

/** The label every suggested station carries, on every surface (OB-INV-05). */
export const SUGGESTED_STATION_LABEL = 'SUGGESTED STATION (not observed)';

/** Why a greedy pass picked fewer stations than declared. */
export type SuggestionStopReason = 'declared-count-reached' | 'no-positive-gain' | 'no-candidates';

/** OB-GAIN-04's result for one greedy pass. */
export interface StationSuggestionResult {
  readonly declaredStationCount: number;
  readonly selectedCandidateIndices: readonly number[];
  /** This candidate's gain at the moment it was picked, in selection order. */
  readonly gainAtSelection: readonly number[];
  /** Every term of each pick at the moment it was picked, in selection order. */
  readonly termsAtSelection: readonly CandidateGainTerms[];
  readonly stopReason: SuggestionStopReason;
}

/**
 * OB-GAIN-04: picks up to `stationCount` candidates, highest gain first, ties
 * to the lower candidate index. Stops early when no remaining candidate has a
 * positive gain. `visibilities[i]` must belong to candidate index `i`.
 */
export function suggestStations(
  field: PlanningField,
  visibilities: readonly CandidateVisibility[],
  params: Pick<CoverageGainParameters, 'stateWeights' | 'redundancyWeight' | 'weakSurfaceFloors'>,
  stationCount: number,
): StationSuggestionResult {
  if (!Number.isInteger(stationCount) || stationCount < 1) {
    throw new Error(`suggestStations: stationCount must be an integer >= 1, got ${stationCount}`);
  }
  const covered = new Set<number>();
  const picked = new Set<number>();
  const selectedCandidateIndices: number[] = [];
  const gainAtSelection: number[] = [];
  const termsAtSelection: CandidateGainTerms[] = [];
  let stopReason: SuggestionStopReason = visibilities.length === 0 ? 'no-candidates' : 'declared-count-reached';

  while (selectedCandidateIndices.length < stationCount && visibilities.length > 0) {
    let best: CandidateGainTerms | null = null;
    for (const vis of visibilities) {
      if (picked.has(vis.candidateIndex)) continue;
      const terms = scoreCandidate(field, vis, params, covered);
      if (best === null || terms.gain > best.gain || (terms.gain === best.gain && terms.candidateIndex < best.candidateIndex)) best = terms;
    }
    if (best === null) {
      stopReason = 'no-candidates';
      break;
    }
    if (!(best.gain > 0)) {
      stopReason = 'no-positive-gain';
      break;
    }
    picked.add(best.candidateIndex);
    selectedCandidateIndices.push(best.candidateIndex);
    gainAtSelection.push(best.gain);
    termsAtSelection.push(best);
    const chosen = visibilities.find((v) => v.candidateIndex === best!.candidateIndex)!;
    for (const key of chosen.keys) covered.add(key);
  }
  return { declaredStationCount: stationCount, selectedCandidateIndices, gainAtSelection, termsAtSelection, stopReason };
}

/** Everything one planning run produced, for the panel, the probe and `candidates.csv`. */
export interface StationPlanningResult {
  readonly instrumentModel: ObservationInstrumentModel;
  readonly parameters: CoverageGainParameters;
  readonly candidates: readonly CoverageCandidate[];
  readonly qualifyingCount: number;
  readonly candidateCap: number;
  readonly droppedByCap: number;
  readonly planningRayCount: number;
  /** Every candidate's terms against the canonical field (round 1). */
  readonly candidateTerms: readonly CandidateGainTerms[];
  readonly suggestion: StationSuggestionResult;
  /** `NOT_READ` voxels in the whole field, all weighted 0 (OB-GAIN-05). */
  readonly notReadVoxelCount: number;
  readonly authority: PlanningAuthorityVerdict;
  readonly methods: readonly string[];
}

export interface StationPlanningInput {
  readonly field: PlanningField;
  readonly model: ObservationInstrumentModel;
  readonly declaredBySource: readonly (DeclaredSourceInstrument | null)[];
  readonly parameters: CoverageGainParameters;
  readonly stationCount: number;
  readonly basis: string;
  readonly stations: readonly { readonly id: string; readonly originStatus: string }[];
  /** Candidates given by position instead of generated (a fixture, or a user's own list). */
  readonly candidates?: readonly CoverageCandidate[];
}

/** Candidate generation (or the given list), visibility, round-1 terms and the greedy pass, in one call. */
export function planStations(input: StationPlanningInput): StationPlanningResult {
  const model = resolveInstrumentModel(input.model, input.declaredBySource);
  const p = input.parameters;
  const generation = input.candidates === undefined
    ? generateCandidates(input.field, model, p)
    : { candidates: input.candidates, qualifyingCount: input.candidates.length, cap: input.candidates.length, droppedByCap: 0 };
  const directions = planningDirections(model);
  const visibilities = generation.candidates.map((c) => traceCandidateVisibility(input.field, c.candidateIndex, c.position, model, p.p_solid, directions));
  const candidateTerms = visibilities.map((v) => scoreCandidate(input.field, v, p));
  const suggestion = suggestStations(input.field, visibilities, p, input.stationCount);
  let notReadVoxelCount = 0;
  for (const s of input.field.stateByKey.values()) if (s === 'NOT_READ') notReadVoxelCount++;
  return {
    instrumentModel: model,
    parameters: p,
    candidates: generation.candidates,
    qualifyingCount: generation.qualifyingCount,
    candidateCap: generation.cap,
    droppedByCap: generation.droppedByCap,
    planningRayCount: directions.length / 3,
    candidateTerms,
    suggestion,
    notReadVoxelCount,
    authority: planningAuthority(input.basis, input.stations, notReadVoxelCount),
    methods: ['olv.observation.coverage-gain', 'olv.observation.station-suggestion'],
  };
}
