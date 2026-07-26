/**
 * runTier.test.ts — the child entry point for one isolated scaling tier.
 *
 * Spawned by `scalingIsolated.ts`, one process per rung, so ladder order is not
 * confounded with process history: a fresh process has no heap the previous
 * tier grew and no JIT state the previous tier warmed.
 *
 * A vitest file rather than a plain script for the same reason the parent is
 * one: the pipeline's provenance path reads the `__BUILD_IDENTITY__` define at
 * module load, and a bare `node` child dies before a stage exists to report.
 *
 * It writes its result to `BENCHMARK_TIER_OUT` and asserts nothing about the
 * tier's verdict. A tier that fails is a result the parent must publish with its
 * reason, not a child that should exit non-zero and lose the record.
 */
import { describe, test, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { parseScalingConfig } from '../../benchmarks/runner/config';
import { runTier } from '../../benchmarks/runner/scaling';

const tierId = process.env.BENCHMARK_TIER;
const outPath = process.env.BENCHMARK_TIER_OUT;
const rawConfig = process.env.BENCHMARK_TIER_CONFIG;

describe('one isolated scaling tier', () => {
  test.runIf(tierId !== undefined && outPath !== undefined && rawConfig !== undefined)(
    'runs the requested tier and writes it out',
    () => {
      const config = parseScalingConfig(JSON.parse(rawConfig as string));
      const tier = config.tiers.find((t) => t.id === tierId);
      expect(tier, `tier ${String(tierId)} is not in the configuration`).toBeDefined();

      const result = runTier(config, tier!);
      writeFileSync(outPath as string, JSON.stringify(result), 'utf8');
      console.log(`tier ${result.tier.id}: ${result.status}, ${result.runs.length} runs`);
    },
    3_600_000,
  );

  test.runIf(tierId === undefined)('is inert unless a tier was requested', () => {
    expect(typeof runTier).toBe('function');
  });
});
