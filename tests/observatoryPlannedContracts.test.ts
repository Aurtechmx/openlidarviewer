/**
 * observatoryPlannedContracts.test.ts — the declared type contracts behind
 * the six not-yet-implemented `olv.observation.*` methods (OB-INT-04).
 *
 * `src/observation/rays.ts`, `ledger.ts`, `strength.ts`, `shadowFrontier.ts`,
 * `coverageGain.ts` and `stationSuggestion.ts` hold no traversal, scoring or
 * search code; SPEC §10 schedules that for O3 through O10. What they DO hold
 * is a real, checkable shape: a structure-of-arrays layout, a literal
 * constant SPEC states verbatim, an interface with a field relationship. This
 * file is the supporting test `tests/methodSupportingTests.test.ts` requires
 * for each of those six ids: not a test of an implementation that does not
 * exist, but a test that the contract the implementation will have to satisfy
 * is internally consistent and matches SPEC today.
 */
import { describe, it, expect } from 'vitest';
import type { ObservationRayChunk, RaySubsampling } from '../src/observation/rays';
import type { ObservationLedgerRow, TraversalBudgetEstimate } from '../src/observation/ledger';
import { EMPTY_OBSERVATION_COUNTERS, createPresenceMask } from '../src/observation/types';
import { SOURCES_SATURATION_CAP_EXAMPLE, type ObservationStrengthComponents } from '../src/observation/strength';
import type { ShadowFrontierResult } from '../src/observation/shadowFrontier';
import {
  DEFAULT_GAIN_STATE_WEIGHTS,
  type ObservationInstrumentModel,
  type CandidateGainTerms,
} from '../src/observation/coverageGain';
import type {
  ReachabilityProvider,
  ReachabilityVerdict,
  StationSuggestionResult,
} from '../src/observation/stationSuggestion';

describe('olv.observation.rays — ObservationRayChunk / RaySubsampling', () => {
  it('a two-ray chunk keeps the OB-RAY-04 array-length relationship', () => {
    const chunk: ObservationRayChunk = {
      originIndex: Uint16Array.from([0, 0]),
      direction: Float32Array.from([1, 0, 0, 0, 1, 0]),
      range: Float32Array.from([5, Number.NaN]),
      returnOffset: Uint32Array.from([0, 1]),
    };
    expect(chunk.direction.length).toBe(chunk.originIndex.length * 3);
    expect(chunk.range.length).toBe(chunk.originIndex.length);
    // A no-return ray's range is NaN, never a sentinel number (OB-RAY-01).
    expect(Number.isNaN(chunk.range[1])).toBe(true);
  });

  it('every RaySubsampling variant narrows on its own kind', () => {
    const variants: RaySubsampling[] = [
      { kind: 'none' },
      { kind: 'grid-stride', k: 4 },
      { kind: 'hash-threshold', threshold: 0.1 },
    ];
    for (const v of variants) {
      if (v.kind === 'grid-stride') expect(v.k).toBeGreaterThan(0);
      if (v.kind === 'hash-threshold') expect(v.threshold).toBeGreaterThan(0);
    }
    expect(variants.map((v) => v.kind)).toEqual(['none', 'grid-stride', 'hash-threshold']);
  });
});

describe('olv.observation.ledger — ObservationLedgerRow / TraversalBudgetEstimate', () => {
  it('a ledger row accepts the real, already-tested ObservationCounters shape, plus O4\'s presence and perSource fields', () => {
    const row: ObservationLedgerRow = {
      key: 42,
      counters: EMPTY_OBSERVATION_COUNTERS,
      presence: createPresenceMask(1),
      perSource: [],
    };
    expect(row.counters.hit).toBe(0);
    expect(row.counters.saturated).toBe(false);
    expect(row.presence.length).toBe(1);
    expect(row.perSource).toEqual([]);
  });

  it('a budget estimate agrees with its own declared arithmetic', () => {
    const withinBudget: TraversalBudgetEstimate = {
      estimatedSteps: 100,
      voxelEdge: 0.5,
      declaredBudget: 200,
      withinBudget: true,
    };
    const overBudget: TraversalBudgetEstimate = {
      estimatedSteps: 500,
      voxelEdge: 0.5,
      declaredBudget: 200,
      withinBudget: false,
    };
    expect(withinBudget.estimatedSteps <= withinBudget.declaredBudget).toBe(withinBudget.withinBudget);
    expect(overBudget.estimatedSteps <= overBudget.declaredBudget).toBe(overBudget.withinBudget);
  });
});

describe('olv.observation.strength — SOURCES_SATURATION_CAP_EXAMPLE / components', () => {
  it('matches SPEC §2.5\'s own worked example, min(sources, 3) / 3', () => {
    expect(SOURCES_SATURATION_CAP_EXAMPLE).toBe(3);
    expect(Math.min(2, SOURCES_SATURATION_CAP_EXAMPLE) / SOURCES_SATURATION_CAP_EXAMPLE).toBeCloseTo(2 / 3);
    expect(Math.min(5, SOURCES_SATURATION_CAP_EXAMPLE) / SOURCES_SATURATION_CAP_EXAMPLE).toBe(1); // saturates
  });

  it('the four bounded components fit [0, 1]; sources does not need to', () => {
    const components: ObservationStrengthComponents = {
      sources: 5,
      angularSpread: 0.4,
      incidence: 0.9,
      rangeFit: 1,
      consistency: 0.75,
    };
    for (const key of ['angularSpread', 'incidence', 'rangeFit', 'consistency'] as const) {
      expect(components[key]).toBeGreaterThanOrEqual(0);
      expect(components[key]).toBeLessThanOrEqual(1);
    }
    expect(components.sources).toBeGreaterThan(1); // unbounded before the saturating map
  });
});

describe('olv.observation.shadow-frontier — ShadowFrontierResult', () => {
  it('withholds area (null) rather than a computed number when the unit is unknown (OB-INV-10)', () => {
    const unknownUnit: ShadowFrontierResult = {
      frontierVoxelKeys: [1, 2, 3],
      areaSquareMetres: null,
      adjacentToShadowed: 2,
      adjacentToUnaddressed: 1,
      adjacentToNoReturnPath: 0,
    };
    const knownUnit: ShadowFrontierResult = { ...unknownUnit, areaSquareMetres: 3 * 0.01 };
    expect(unknownUnit.areaSquareMetres).toBeNull();
    expect(knownUnit.areaSquareMetres).toBeCloseTo(0.03);
  });
});

describe('olv.observation.coverage-gain — instrument model / gain terms / default weights', () => {
  it('DEFAULT_GAIN_STATE_WEIGHTS matches SPEC §5.6 OB-GAIN-03 exactly', () => {
    expect(DEFAULT_GAIN_STATE_WEIGHTS).toEqual({
      SHADOWED: 1.0,
      UNADDRESSED: 1.0,
      NO_RETURN_PATH: 0.25,
      CONFLICT: 0.5,
      WEAK_SURFACE: 0.5,
    });
  });

  it('an instrument model may declare its own parameters or copy another source', () => {
    const own: ObservationInstrumentModel = {
      heightAboveSurface: 1.6,
      minRange: 0.5,
      maxRange: 120,
      verticalFieldOfViewDegrees: 60,
      angularStepDegrees: 0.1,
      sameAsSourceIndex: null,
    };
    const copied: ObservationInstrumentModel = { ...own, sameAsSourceIndex: 0 };
    expect(own.sameAsSourceIndex).toBeNull();
    expect(copied.sameAsSourceIndex).toBe(0);
  });

  it('gain terms report every component separately, not only the sum (OB-GAIN-03)', () => {
    const terms: CandidateGainTerms = {
      candidateIndex: 3,
      weightedVisibilitySum: 12.5,
      redundantPenalty: 2.0,
      gain: 10.5,
      excludedVoxelCount: 4,
    };
    expect(terms.gain).toBeCloseTo(terms.weightedVisibilitySum - terms.redundantPenalty);
  });
});

describe('olv.observation.station-suggestion — ReachabilityProvider / StationSuggestionResult', () => {
  it('a conforming ReachabilityProvider always carries an evidence reference', () => {
    const provider: ReachabilityProvider = {
      verdictAt: (position) => ({
        verdict: (position[2] > 0 ? 'reachable' : 'unknown') as ReachabilityVerdict,
        evidenceRef: 'fixture:flat-ground',
      }),
    };
    const verdict = provider.verdictAt([0, 0, 1]);
    expect(['reachable', 'unreachable', 'unknown']).toContain(verdict.verdict);
    expect(verdict.evidenceRef.length).toBeGreaterThan(0);
  });

  it('a greedy result names one gain figure per selected candidate, in order', () => {
    const result: StationSuggestionResult = {
      declaredStationCount: 2,
      selectedCandidateIndices: [7, 3],
      gainAtSelection: [14.2, 6.1],
    };
    expect(result.selectedCandidateIndices.length).toBe(result.gainAtSelection.length);
    expect(result.selectedCandidateIndices.length).toBeLessThanOrEqual(result.declaredStationCount);
  });
});
