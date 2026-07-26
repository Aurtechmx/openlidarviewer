/**
 * scaling.ts
 *
 * Benchmark 2: how the real pipeline behaves as the input grows, 50k → 1M.
 *
 * WHAT THIS SUITE DOES NOT CLAIM. No complexity class. Five tiers over one
 * machine cannot separate O(n log n) from O(n^1.1), and a fitted exponent from
 * five points would be a number with a confidence interval nobody computed. The
 * output is a descriptive curve: the measured medians, their spread, and the
 * grid and contour counts that explain the shape. A reader can draw their own
 * conclusion from `raw.json`; the suite does not draw it for them.
 *
 * WHY THE 1M TIER IS NOT OPTIONAL. A ladder that quietly stops at the size that
 * fits is a ladder that reports whatever the machine found easy. If 1M cannot
 * complete here, that is a real, publishable finding about a real resource
 * limit — so the tier stays in the configuration, its failure is preserved in
 * `raw.json` with the exact reason, and the suite fails. The only way to accept
 * the limitation is to name the tier in `acceptedTierFailures`, which puts the
 * decision in the repository where it can be reviewed.
 *
 * WHY EVERY TIER IS RUN TO COMPLETION EVEN AFTER ONE FAILS. Stopping at the
 * first failure would leave the higher tiers unmeasured AND unexplained, which
 * looks identical to never having configured them.
 *
 * Strictly sequential, one run at a time, no concurrency anywhere: two pipelines
 * sharing a core would make every duration a measurement of the scheduler.
 */

import { scienceScopedArtifacts } from '../pipeline/runPipeline';
import {
  BENCHMARK_PACKAGE_VERSION,
  BENCHMARK_SCHEMA_VERSION,
  type ScalingConfig,
  type ScalingTier,
} from './config';
import { executeRun } from './execute';
import type { RunObservation } from './observe';
import {
  SERIES_ANALYSIS_MS,
  SERIES_PEAK_RSS_BYTES,
  SERIES_PIPELINE_TOTAL_MS,
  SERIES_POINTS_PER_SECOND,
  seriesOf,
  type RunSeries,
} from './series';
import { QUANTILE_CONVENTION } from './stats';
import { summariseRuns, type SummarisedSeries } from './summarise';

/**
 * The metrics a scaling table is read for. Named here so "no principal metric
 * missing" is a checkable condition rather than a judgement call at review time.
 */
export const PRINCIPAL_SERIES = [
  SERIES_ANALYSIS_MS,
  SERIES_PIPELINE_TOTAL_MS,
  SERIES_POINTS_PER_SECOND,
  SERIES_PEAK_RSS_BYTES,
] as const;

export interface ScalingRunRecord {
  readonly index: number;
  readonly observation: RunObservation;
  readonly series: RunSeries;
}

export interface ScalingTierResult {
  readonly tier: ScalingTier;
  readonly status: 'ok' | 'failed';
  /** Present exactly when the status is 'failed'. The observed reason, verbatim. */
  readonly failureReason: string | null;
  /** True when the failure is one the configuration deliberately accepts. */
  readonly failureAccepted: boolean;
  readonly warmupRunsCompleted: number;
  readonly runs: readonly ScalingRunRecord[];
  readonly series: SummarisedSeries;
  /** Science hashes of the tier's first run, and whether the tier agreed. */
  readonly referenceScienceHashes: Readonly<Record<string, string>>;
  readonly scienceHashesStableWithinTier: boolean;
  readonly hashDivergences: readonly string[];
  /** Structural outputs, identical across a tier's runs by construction. */
  readonly gridCols: number | null;
  readonly gridRows: number | null;
  readonly gridCellCount: number | null;
  readonly contourCount: number | null;
  readonly qualityScore: number | null;
  readonly meanConfidence: number | null;
  readonly generatedPointCount: number | null;
  readonly forcedGcAvailable: boolean;
}

export interface ScalingRaw {
  readonly schemaVersion: number;
  readonly benchmarkPackageVersion: string;
  readonly suiteId: 'scaling';
  readonly quantileConvention: string;
  readonly config: ScalingConfig;
  readonly tiers: readonly ScalingTierResult[];
}

export interface ScalingSummary {
  readonly schemaVersion: number;
  readonly benchmarkPackageVersion: string;
  readonly suiteId: 'scaling';
  readonly quantileConvention: string;
  readonly config: ScalingConfig;
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly tiers: readonly ScalingTierSummary[];
}

export interface ScalingTierSummary {
  readonly id: string;
  readonly requestedPointCount: number;
  readonly generatedPointCount: number | null;
  readonly status: 'ok' | 'failed';
  readonly failureReason: string | null;
  readonly failureAccepted: boolean;
  readonly runCount: number;
  readonly series: SummarisedSeries;
  readonly gridCols: number | null;
  readonly gridRows: number | null;
  readonly gridCellCount: number | null;
  readonly contourCount: number | null;
  readonly qualityScore: number | null;
  readonly meanConfidence: number | null;
  readonly scienceHashesStableWithinTier: boolean;
  readonly forcedGcAvailable: boolean;
}

export interface ScalingResult {
  readonly raw: ScalingRaw;
  readonly summary: ScalingSummary;
}

function runTier(config: ScalingConfig, tier: ScalingTier): ScalingTierResult {
  let warmupRunsCompleted = 0;
  let fatal: string | null = null;

  for (let i = 0; i < config.warmupRuns && fatal === null; i++) {
    try {
      executeRun({ index: -1, seed: config.seed, pointCount: tier.pointCount, terrain: config.terrain });
      warmupRunsCompleted++;
    } catch (err) {
      // The driver records a stage failure without throwing, so a throw here is
      // something it could not contain — an allocation the runtime refused, for
      // instance. Kept verbatim: "the 1m tier failed" is not a finding, the
      // engine's own message is.
      fatal = `warm-up run threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const runs: ScalingRunRecord[] = [];
  for (let i = 0; i < config.recordedRuns && fatal === null; i++) {
    try {
      const observation = executeRun({
        index: i + 1,
        seed: config.seed,
        pointCount: tier.pointCount,
        terrain: config.terrain,
      });
      runs.push({ index: i + 1, observation, series: seriesOf(observation) });
    } catch (err) {
      fatal = `recorded run ${i + 1} threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const stageFailures: string[] = [];
  for (const run of runs) {
    for (const stage of run.observation.failedStages) {
      stageFailures.push(`run ${run.index}: stage ${stage.name} failed — ${stage.error}`);
    }
  }

  const expectedScience = scienceScopedArtifacts();
  const reference = runs[0]?.observation ?? null;
  const hashDivergences: string[] = [];
  if (reference !== null) {
    for (const run of runs.slice(1)) {
      for (const name of expectedScience) {
        const a = reference.scienceHashes[name];
        const b = run.observation.scienceHashes[name];
        if (a !== b) hashDivergences.push(`run ${run.index}: ${name}: ${String(a)} vs ${String(b)}`);
      }
    }
  }

  const series = summariseRuns(runs.map((r) => r.series), config.recordedRuns);

  const reasons: string[] = [];
  if (fatal !== null) reasons.push(fatal);
  if (runs.length !== config.recordedRuns) {
    reasons.push(`completed ${runs.length} of ${config.recordedRuns} recorded runs`);
  }
  reasons.push(...stageFailures);
  if (hashDivergences.length > 0) {
    reasons.push(`science hashes were not stable within the tier: ${hashDivergences.join('; ')}`);
  }
  for (const key of PRINCIPAL_SERIES) {
    const missing = series.unavailable.find((u) => u.key === key);
    if (missing) reasons.push(`principal metric ${key} has no summary — ${missing.reason}`);
  }

  const status = reasons.length === 0 ? 'ok' : 'failed';
  return {
    tier,
    status,
    failureReason: status === 'failed' ? reasons.join(' | ') : null,
    failureAccepted: status === 'failed' && config.acceptedTierFailures.includes(tier.id),
    warmupRunsCompleted,
    runs,
    series,
    referenceScienceHashes: reference?.scienceHashes ?? {},
    scienceHashesStableWithinTier: hashDivergences.length === 0,
    hashDivergences,
    gridCols: reference?.scalars.gridCols ?? null,
    gridRows: reference?.scalars.gridRows ?? null,
    gridCellCount: reference?.scalars.gridCellCount ?? null,
    contourCount: reference?.scalars.contourPolylineCount ?? null,
    qualityScore: reference?.scalars.qualityScore ?? null,
    meanConfidence: reference?.scalars.meanConfidence ?? null,
    generatedPointCount: reference?.generatedPointCount ?? null,
    forcedGcAvailable: reference?.memory.forcedGcAvailable ?? false,
  };
}

export function runScalingSuite(config: ScalingConfig): ScalingResult {
  const tiers = config.tiers.map((tier) => runTier(config, tier));

  const failures: string[] = [];
  for (const tier of tiers) {
    if (tier.status !== 'failed') continue;
    const line = `tier ${tier.tier.id} (${tier.tier.pointCount} points) failed: ${tier.failureReason ?? 'no reason recorded'}`;
    // An accepted failure is still PRESERVED in the output with its reason; it
    // simply stops gating the suite. The record and the verdict are separate
    // things, and only the verdict is configurable.
    if (tier.failureAccepted) continue;
    failures.push(line);
  }

  const summary: ScalingSummary = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmarkPackageVersion: BENCHMARK_PACKAGE_VERSION,
    suiteId: 'scaling',
    quantileConvention: QUANTILE_CONVENTION,
    config,
    pass: failures.length === 0,
    failures,
    tiers: tiers.map((tier) => ({
      id: tier.tier.id,
      requestedPointCount: tier.tier.pointCount,
      generatedPointCount: tier.generatedPointCount,
      status: tier.status,
      failureReason: tier.failureReason,
      failureAccepted: tier.failureAccepted,
      runCount: tier.runs.length,
      series: tier.series,
      gridCols: tier.gridCols,
      gridRows: tier.gridRows,
      gridCellCount: tier.gridCellCount,
      contourCount: tier.contourCount,
      qualityScore: tier.qualityScore,
      meanConfidence: tier.meanConfidence,
      scienceHashesStableWithinTier: tier.scienceHashesStableWithinTier,
      forcedGcAvailable: tier.forcedGcAvailable,
    })),
  };

  return {
    raw: {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      benchmarkPackageVersion: BENCHMARK_PACKAGE_VERSION,
      suiteId: 'scaling',
      quantileConvention: QUANTILE_CONVENTION,
      config,
      tiers,
    },
    summary,
  };
}
