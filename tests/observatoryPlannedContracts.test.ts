/**
 * observatoryPlannedContracts.test.ts — the declared type contracts behind
 * four `olv.observation.*` methods registered before their code (OB-INT-04).
 *
 * `src/observation/rays.ts`, `ledger.ts`, `strength.ts` and `shadowFrontier.ts`
 * were registered before their traversal and search code landed (O3-O6). What they DO hold
 * is a real, checkable shape: a structure-of-arrays layout, a literal
 * constant SPEC states verbatim, an interface with a field relationship. This
 * file is the supporting test `tests/methodSupportingTests.test.ts` requires
 * for each of those four ids: not a test of an implementation that does not
 * exist, but a test that the contract the implementation will have to satisfy
 * is internally consistent and matches SPEC today.
 */
import { describe, it, expect } from 'vitest';
import type { ObservationRayChunk, RaySubsampling } from '../src/observation/rays';
import type { ObservationLedgerRow, TraversalBudgetEstimate } from '../src/observation/ledger';
import { EMPTY_OBSERVATION_COUNTERS, createPresenceMask } from '../src/observation/types';
import { SOURCES_SATURATION_CAP_EXAMPLE, type ObservationStrengthComponents } from '../src/observation/strength';
import type { ShadowFrontierResult } from '../src/observation/shadowFrontier';

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
