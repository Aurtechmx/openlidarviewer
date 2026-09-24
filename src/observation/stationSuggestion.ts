/**
 * stationSuggestion.ts — greedy multi-station selection and reachability
 * contract (docs/observatory/SPEC.md §5.6, OB-GAIN-04, OB-GAIN-06).
 *
 * NOT IMPLEMENTED. `olv.observation.station-suggestion` is registered ahead
 * of phase O10, which runs the greedy sequential search over Coverage Gain
 * candidates (`coverageGain.ts`). SPEC is explicit that OB-GAIN-06 defines
 * ONLY the `ReachabilityProvider` interface for v0.7 — "There is no
 * implementation in v0.7; Terrain Access does not exist" — so that interface
 * is transcribed here verbatim rather than paraphrased, and the panel offers
 * no "reachable" mode until a provider with recorded evidence is registered.
 *
 * Pure and DOM-free (OB-INT-01). No greedy search, no hypothetical-ledger copy
 * and no reachability provider is implemented here or anywhere yet.
 */

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

/**
 * OB-GAIN-04's declared result shape for one greedy pass: the stations picked
 * in order, each against the hypothetical ledger copy left by the ones before
 * it. The canonical ledger this ran against is never mutated by the search.
 */
export interface StationSuggestionResult {
  readonly declaredStationCount: number;
  readonly selectedCandidateIndices: readonly number[];
  /** This candidate's gain at the moment it was picked, in selection order. */
  readonly gainAtSelection: readonly number[];
}
