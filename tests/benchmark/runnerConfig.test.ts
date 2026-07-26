/**
 * runnerConfig.test.ts — configuration parsing, seeds and repetition counts.
 *
 * The parser exists because a configuration round-trips through `raw.json` and
 * comes back as untyped JSON, so these cases are all shapes TypeScript cannot
 * catch at the boundary: a string where a count belongs, a fractional
 * repetition, a ladder that does not ascend.
 */
import { describe, test, expect } from 'vitest';
import {
  BENCHMARK_SEED,
  REPRODUCIBILITY_CONFIG,
  SCALING_CONFIG,
  parseReproducibilityConfig,
  parseScalingConfig,
} from '../../benchmarks/runner/config';
import { generateSyntheticCloud } from '../../benchmarks/fixtures/syntheticCloud';

/** A JSON round trip, exactly as the verifier sees a published configuration. */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('the shipped configurations', () => {
  test('survive a JSON round trip unchanged', () => {
    expect(parseReproducibilityConfig(roundTrip(REPRODUCIBILITY_CONFIG))).toEqual(REPRODUCIBILITY_CONFIG);
    expect(parseScalingConfig(roundTrip(SCALING_CONFIG))).toEqual(SCALING_CONFIG);
  });

  test('state the repetition counts the suites promise', () => {
    expect(REPRODUCIBILITY_CONFIG.warmupRuns).toBe(1);
    expect(REPRODUCIBILITY_CONFIG.recordedRuns).toBe(10);
    expect(REPRODUCIBILITY_CONFIG.pointCount).toBe(250_000);
    expect(SCALING_CONFIG.warmupRuns).toBe(1);
    expect(SCALING_CONFIG.recordedRuns).toBe(5);
  });

  test('ship the full ladder including the 1M tier', () => {
    expect(SCALING_CONFIG.tiers.map((t) => t.pointCount)).toEqual([
      50_000, 100_000, 250_000, 500_000, 1_000_000,
    ]);
    // A tier accepted as a known failure would stop gating the suite, so the
    // shipped list being empty is a property worth pinning rather than assuming.
    expect(SCALING_CONFIG.acceptedTierFailures).toEqual([]);
  });

  test('use one documented seed for both suites', () => {
    expect(REPRODUCIBILITY_CONFIG.seed).toBe(BENCHMARK_SEED);
    expect(SCALING_CONFIG.seed).toBe(BENCHMARK_SEED);
  });
});

describe('deterministic seed handling', () => {
  test('the same seed reproduces the same bytes, a different seed does not', () => {
    const a = generateSyntheticCloud({ seed: BENCHMARK_SEED, pointCount: 2_000 });
    const b = generateSyntheticCloud({ seed: BENCHMARK_SEED, pointCount: 2_000 });
    const c = generateSyntheticCloud({ seed: BENCHMARK_SEED + 1, pointCount: 2_000 });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions));
    expect(a.datasetId).toBe(b.datasetId);
    expect(a.datasetId).not.toBe(c.datasetId);
  });
});

describe('the parser refuses a configuration a summary could not be trusted from', () => {
  const repro = (overrides: Record<string, unknown>): unknown => ({
    ...REPRODUCIBILITY_CONFIG,
    ...overrides,
  });

  test('a count that arrived as a string', () => {
    expect(() => parseReproducibilityConfig(repro({ recordedRuns: '10' }))).toThrow(
      /recordedRuns must be a positive integer/,
    );
  });

  test('a fractional or zero repetition count', () => {
    expect(() => parseReproducibilityConfig(repro({ recordedRuns: 2.5 }))).toThrow(/positive integer/);
    // Zero recorded runs would make every statistic a summary over nothing.
    expect(() => parseReproducibilityConfig(repro({ recordedRuns: 0 }))).toThrow(/positive integer/);
  });

  test('a negative warm-up count, while zero warm-ups stay legal', () => {
    expect(() => parseReproducibilityConfig(repro({ warmupRuns: -1 }))).toThrow(/non-negative integer/);
    expect(parseReproducibilityConfig(repro({ warmupRuns: 0 })).warmupRuns).toBe(0);
  });

  test('a non-finite seed', () => {
    expect(() => parseReproducibilityConfig(repro({ seed: Number.NaN }))).toThrow(/seed must be a finite number/);
  });

  test('a widened scalar tolerance', () => {
    expect(() => parseReproducibilityConfig(repro({ scalarTolerance: 1e-9 }))).toThrow(
      /scalarTolerance must be exactly 0/,
    );
  });

  test('a terrain block with no cell size', () => {
    expect(() =>
      parseReproducibilityConfig(repro({ terrain: { ...REPRODUCIBILITY_CONFIG.terrain, cellSizeM: 0 } })),
    ).toThrow(/cellSizeM must be positive/);
  });

  test('the wrong suite id', () => {
    expect(() => parseReproducibilityConfig(repro({ suiteId: 'scaling' }))).toThrow(/suiteId/);
    expect(() => parseScalingConfig({ ...SCALING_CONFIG, suiteId: 'reproducibility' })).toThrow(/suiteId/);
  });

  test('an empty, duplicated or descending ladder', () => {
    expect(() => parseScalingConfig({ ...SCALING_CONFIG, tiers: [] })).toThrow(/non-empty array/);
    expect(() =>
      parseScalingConfig({
        ...SCALING_CONFIG,
        tiers: [
          { id: 'a', pointCount: 10 },
          { id: 'a', pointCount: 20 },
        ],
      }),
    ).toThrow(/duplicate tier id/);
    expect(() =>
      parseScalingConfig({
        ...SCALING_CONFIG,
        tiers: [
          { id: 'big', pointCount: 20 },
          { id: 'small', pointCount: 10 },
        ],
      }),
    ).toThrow(/must ascend/);
  });

  test('an accepted failure naming a tier that does not exist', () => {
    expect(() => parseScalingConfig({ ...SCALING_CONFIG, acceptedTierFailures: ['10m'] })).toThrow(
      /unknown tier/,
    );
  });
});
