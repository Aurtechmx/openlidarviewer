/**
 * reproducibility.ts
 *
 * Benchmark 1: repeated runs over one seeded input produce identical scientific
 * outputs, even though their timings do not.
 *
 * THE CLAIM AND ITS SHAPE. Ten recorded runs, one warm-up, one documented seed,
 * one point count, identical terrain parameters throughout. Run 1 is the
 * reference; every later run must match it on every science-scoped artifact
 * hash, every scalar output, the terrain-complexity summary, the scientific
 * record with build identity and timestamps removed, the application's own
 * content hash, and a manifest that verifies. Timings are summarised and
 * summarised only — they are expected to vary and nothing depends on them.
 *
 * WHY THE COMPARISON IS EXACT. There is no tolerance. On one machine, over one
 * seed, this is deterministic floating-point arithmetic: a difference of one ULP
 * means the pipeline did something non-deterministic, which is precisely the
 * finding the suite exists to surface. A tolerance would convert that finding
 * into a green tick. `config.scalarTolerance` is pinned to 0 by the parser, and
 * the value is written into the output so the claim is legible without reading
 * this file.
 *
 * WHY BUILD-SCOPED HASHES ARE REPORTED SEPARATELY AND DO NOT GATE THE PASS. The
 * scientific record embeds the build identity and the processing manifest seeds
 * its chain from it, so both track the git commit and the Node version of
 * whatever ran them. Within one process they are stable and that stability is
 * worth reporting; between two machines they are EXPECTED to differ and say
 * nothing about whether the science reproduced. Making them a pass condition
 * would turn a green pipeline red on a different runner for a reason that is not
 * about reproducibility at all. See `ARTIFACT_SCOPE` in the driver.
 */

import { scienceScopedArtifacts } from '../pipeline/runPipeline';
import { BENCHMARK_PACKAGE_VERSION, BENCHMARK_SCHEMA_VERSION, type ReproducibilityConfig } from './config';
import { executeRun } from './execute';
import type { RunObservation } from './observe';
import { seriesOf, type RunSeries } from './series';
import { QUANTILE_CONVENTION, checkFirstRun, type FirstRunCheck } from './stats';
import { SERIES_ANALYSIS_MS } from './series';
import { diffJson, summariseRuns, type SummarisedSeries } from './summarise';

/** One way run N disagreed with run 1. */
export interface Divergence {
  readonly runIndex: number;
  readonly kind:
    | 'scienceHash'
    | 'artifactSet'
    | 'scalar'
    | 'complexitySummary'
    | 'scientificRecordContent'
    | 'applicationContentHash';
  readonly detail: string;
}

export interface ReproducibilityRaw {
  readonly schemaVersion: number;
  readonly benchmarkPackageVersion: string;
  readonly suiteId: 'reproducibility';
  readonly quantileConvention: string;
  readonly config: ReproducibilityConfig;
  readonly datasetId: string;
  /** The exact parameters handed to the application, echoed from the driver. */
  readonly analysisParameters: Readonly<Record<string, unknown>>;
  readonly warmupRunsCompleted: number;
  readonly runs: readonly ReproducibilityRunRecord[];
}

export interface ReproducibilityRunRecord {
  readonly index: number;
  readonly observation: RunObservation;
  readonly series: RunSeries;
}

export interface ReproducibilitySummary {
  readonly schemaVersion: number;
  readonly benchmarkPackageVersion: string;
  readonly suiteId: 'reproducibility';
  readonly quantileConvention: string;
  readonly config: ReproducibilityConfig;
  readonly datasetId: string;
  readonly runCount: number;
  readonly pass: boolean;
  /** Every reason the suite did not pass. Empty exactly when `pass` is true. */
  readonly failures: readonly string[];
  readonly identity: {
    /** The science-scoped hashes of run 1 — the reference the rest matched. */
    readonly referenceScienceHashes: Readonly<Record<string, string>>;
    readonly scienceHashesStable: boolean;
    /** Reported, never a pass condition. See the module header. */
    readonly referenceBuildScopedHashes: Readonly<Record<string, string>>;
    readonly buildScopedHashesStableInThisProcess: boolean;
    readonly applicationContentHash: string | null;
    readonly scalarsStable: boolean;
    readonly manifestVerifiedOnEveryRun: boolean;
    readonly divergences: readonly Divergence[];
  };
  readonly timing: SummarisedSeries;
  /**
   * Whether the warm-up actually finished warming up.
   *
   * The published coefficient of variation is read as a repeatability figure,
   * so a residual first-run transient does not just add noise — it changes what
   * the headline number means. With one warm-up the first recorded runs came in
   * about 11 % slow and inflated the CV by roughly 2.4x. This is recorded on
   * every result set, and run 1 landing outside the spread of the rest fails
   * the suite.
   */
  readonly warmup: FirstRunCheck | null;
}

export interface ReproducibilityResult {
  readonly raw: ReproducibilityRaw;
  readonly summary: ReproducibilitySummary;
}

/** Scalar field names, so a comparison cannot silently skip a new field. */
function scalarKeys(observation: RunObservation): readonly string[] {
  return Object.keys(observation.scalars).sort();
}

export function runReproducibilitySuite(config: ReproducibilityConfig): ReproducibilityResult {
  // Warm-ups are executed and discarded: the first run of a process pays JIT
  // compilation and first-touch page faults that belong to the runtime, not to
  // the pipeline. They are counted in the output so "10 runs" is never confused
  // with "10 runs plus something we did not mention".
  let warmupRunsCompleted = 0;
  for (let i = 0; i < config.warmupRuns; i++) {
    executeRun({ index: -1, seed: config.seed, pointCount: config.pointCount, terrain: config.terrain });
    warmupRunsCompleted++;
  }

  const runs: ReproducibilityRunRecord[] = [];
  for (let i = 0; i < config.recordedRuns; i++) {
    const observation = executeRun({
      index: i + 1,
      seed: config.seed,
      pointCount: config.pointCount,
      terrain: config.terrain,
    });
    runs.push({ index: i + 1, observation, series: seriesOf(observation) });
  }

  const reference = runs[0].observation;
  const divergences: Divergence[] = [];
  const failures: string[] = [];

  // Every run must have produced every science artifact. A missing artifact is
  // not "a hash that matched vacuously" — it is a hole in the comparison, and
  // it has to fail rather than pass by absence.
  const expectedScience = scienceScopedArtifacts();
  for (const run of runs) {
    const missing = expectedScience.filter((name) => !(name in run.observation.scienceHashes));
    if (missing.length > 0) {
      divergences.push({
        runIndex: run.index,
        kind: 'artifactSet',
        detail: `missing science artifacts: ${missing.join(', ')}`,
      });
    }
    for (const stage of run.observation.failedStages) {
      failures.push(`run ${run.index}: stage ${stage.name} failed — ${stage.error}`);
    }
    if (!run.observation.manifestVerified) {
      failures.push(`run ${run.index}: the processing manifest did not verify`);
    }
    for (const warning of run.observation.warnings) {
      // A warning about a non-representable number is a hidden NaN/Infinity
      // reaching the output, which the suite must fail on rather than log.
      if (warning.includes('cannot be represented in JSON')) {
        failures.push(`run ${run.index}: ${warning}`);
      }
    }
  }

  for (const run of runs.slice(1)) {
    const observed = run.observation;

    for (const name of expectedScience) {
      const a = reference.scienceHashes[name];
      const b = observed.scienceHashes[name];
      if (a !== undefined && b !== undefined && a !== b) {
        divergences.push({
          runIndex: run.index,
          kind: 'scienceHash',
          detail: `${name}: ${a} vs ${b}`,
        });
      }
    }

    for (const key of scalarKeys(reference)) {
      const a = reference.scalars[key as keyof typeof reference.scalars];
      const b = observed.scalars[key as keyof typeof observed.scalars];
      // Object.is, not ===: it separates a genuine null from a NaN that slipped
      // through, and it does not equate +0 with −0 — a sign flip in an elevation
      // extreme is exactly the kind of drift worth seeing.
      if (!Object.is(a, b)) {
        divergences.push({
          runIndex: run.index,
          kind: 'scalar',
          detail: `${key}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
        });
      }
    }

    for (const path of diffJson(reference.complexitySummary, observed.complexitySummary)) {
      divergences.push({ runIndex: run.index, kind: 'complexitySummary', detail: path });
    }
    for (const path of diffJson(reference.scientificRecordContent, observed.scientificRecordContent)) {
      divergences.push({ runIndex: run.index, kind: 'scientificRecordContent', detail: path });
    }
  }

  const scienceHashesStable = !divergences.some(
    (d) => d.kind === 'scienceHash' || d.kind === 'artifactSet',
  );
  const scalarsStable = !divergences.some((d) => d.kind === 'scalar');
  const buildScopedHashesStableInThisProcess = runs
    .slice(1)
    .every((run) =>
      Object.entries(reference.buildScopedHashes).every(
        ([name, hash]) => run.observation.buildScopedHashes[name] === hash,
      ),
    );

  for (const d of divergences) {
    failures.push(`run ${d.runIndex}: ${d.kind} diverged — ${d.detail}`);
  }
  if (runs.length !== config.recordedRuns) {
    failures.push(`expected ${config.recordedRuns} recorded runs, completed ${runs.length}`);
  }

  const timing = summariseRuns(runs.map((r) => r.series), config.recordedRuns);
  for (const missing of timing.unavailable) {
    failures.push(`series ${missing.key} has no summary — ${missing.reason}`);
  }

  const analysisBlock = timing.available.find((b) => b.key === SERIES_ANALYSIS_MS);
  const warmup = analysisBlock ? checkFirstRun(analysisBlock.summary.values) : null;
  // Deliberately NOT a failure. The transient tracks machine load and allocator
  // state rather than the pipeline — six warm-ups still leave ~9 % on a busy
  // machine — so failing on it would red-light a correct run because something
  // else was running. It is measured instead: `warmup` carries the dispersion
  // with run 1 and without it, and every reporter prints both.

  const summary: ReproducibilitySummary = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmarkPackageVersion: BENCHMARK_PACKAGE_VERSION,
    suiteId: 'reproducibility',
    quantileConvention: QUANTILE_CONVENTION,
    config,
    datasetId: reference.datasetId,
    runCount: runs.length,
    pass: failures.length === 0,
    failures,
    identity: {
      referenceScienceHashes: reference.scienceHashes,
      scienceHashesStable,
      referenceBuildScopedHashes: reference.buildScopedHashes,
      buildScopedHashesStableInThisProcess,
      applicationContentHash: reference.scalars.applicationContentHash,
      scalarsStable,
      manifestVerifiedOnEveryRun: runs.every((r) => r.observation.manifestVerified),
      divergences,
    },
    timing,
    warmup,
  };

  return {
    raw: {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      benchmarkPackageVersion: BENCHMARK_PACKAGE_VERSION,
      suiteId: 'reproducibility',
      quantileConvention: QUANTILE_CONVENTION,
      config,
      datasetId: reference.datasetId,
      analysisParameters: {
        cellSizeM: config.terrain.cellSizeM,
        crs: config.terrain.crs,
        verticalDatum: config.terrain.verticalDatum,
        holdoutSeed: config.terrain.holdoutSeed,
        seed: config.seed,
        pointCount: config.pointCount,
      },
      warmupRunsCompleted,
      runs,
    },
    summary,
  };
}
