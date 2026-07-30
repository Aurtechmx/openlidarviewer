/**
 * scalingIsolated.ts
 *
 * Run every scaling tier in its OWN process.
 *
 * WHY THIS EXISTS. Run in one process, ladder order is perfectly confounded
 * with process history. JIT state, heap growth and whatever the previous tier
 * left behind all advance monotonically alongside the point count, so a memory
 * column ends up describing the process rather than the workload — measured
 * both ways on one machine, the identical 250k workload reported peak RSS about
 * 50 % apart depending only on what had run before it. A fresh process per tier
 * removes the carry-over entirely, which is the only version of the measurement
 * that can be attributed to the input size.
 *
 * WHY A CHILD `vitest` AND NOT A WORKER. The pipeline's provenance path reads
 * `__BUILD_IDENTITY__`, a Vite/Vitest `define`, at MODULE LOAD. A bare `node`
 * child dies with a ReferenceError before a stage exists, so the child has to
 * be a vitest run too. It executes exactly one tier and writes the result as
 * JSON; this side reads it back and assembles the ladder.
 *
 * A child that dies — an allocation the runtime refused, an OOM kill — produces
 * no file, and that is reported as a FAILED TIER carrying the child's exit
 * status and stderr, never as a missing row. A tier that cannot run on this
 * machine is a finding.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScalingConfig, ScalingTier } from './config';
import { runScalingSuite, type ScalingResult, type ScalingTierResult } from './scaling';
import { summariseRuns } from './summarise';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** The child entry point, relative to the repo root. */
const CHILD_SPEC = 'tests/benchmark/runTier.test.ts';
/** Generous: the top tier is seconds of real terrain work per run, times eight. */
const CHILD_TIMEOUT_MS = 1_800_000;

/**
 * The installed vitest entry point, as an absolute path.
 *
 * Spawning `npx vitest` would resolve the name through `PATH`, which is the one
 * input to a measurement run that nobody records and anybody can prepend to.
 * Node's own resolver answers the same question from this file's location, so
 * the child is launched as `process.execPath` plus a path — no lookup, and the
 * binary that runs is the one this checkout installed.
 */
function vitestEntryPoint(): string {
  const resolve = createRequire(import.meta.url).resolve('vitest/package.json');
  return join(dirname(resolve), 'vitest.mjs');
}

/** A tier that could not be run at all, with the observed reason. */
function deadTier(config: ScalingConfig, tier: ScalingTier, reason: string): ScalingTierResult {
  return {
    tier,
    status: 'failed',
    failureReason: reason,
    failureAccepted: config.acceptedTierFailures.includes(tier.id),
    warmupRunsCompleted: 0,
    runs: [],
    // An empty run set still goes through the ordinary summariser, so the tier's
    // series appear as unavailable-with-reason rather than absent.
    series: summariseRuns([], config.recordedRuns),
    referenceScienceHashes: {},
    scienceHashesStableWithinTier: false,
    hashDivergences: [],
    gridCols: null,
    gridRows: null,
    gridCellCount: null,
    contourCount: null,
    contourIntervalM: null,
    elevationRangeM: null,
    qualityScore: null,
    meanConfidence: null,
    generatedPointCount: null,
    forcedGcAvailable: false,
    firstRunAnalysisMs: null,
  };
}

/** Run one tier in a child vitest process and read its result back. */
function runTierInChildProcess(config: ScalingConfig, tier: ScalingTier): ScalingTierResult {
  const dir = mkdtempSync(join(tmpdir(), 'olv-tier-'));
  const outPath = join(dir, `${tier.id}.json`);
  try {
    execFileSync(
      process.execPath,
      [vitestEntryPoint(), 'run', CHILD_SPEC, `--testTimeout=${CHILD_TIMEOUT_MS}`],
      {
        cwd: REPO_ROOT,
        timeout: CHILD_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // The whole parent environment, deliberately. The child re-reads
        // `vitest.config.ts` in a fresh process, and that is where
        // `BENCHMARK_FORCE_GC` becomes an `--expose-gc` on the worker — so
        // narrowing this to an allowlist of BENCHMARK_TIER_* would leave the
        // parent GC-controlled and every tier measured in the other mode, in one
        // result tree, with nothing to show for it but a shifted curve.
        env: {
          ...process.env,
          BENCHMARK_TIER: tier.id,
          BENCHMARK_TIER_POINTS: String(tier.pointCount),
          BENCHMARK_TIER_CONFIG: JSON.stringify(config),
          BENCHMARK_TIER_OUT: outPath,
        },
      },
    );
    if (!existsSync(outPath)) {
      return deadTier(config, tier, 'the child process exited without writing a tier result');
    }
    return JSON.parse(readFileSync(outPath, 'utf8')) as ScalingTierResult;
  } catch (err) {
    // Kept verbatim and trimmed to one line: "the 1m tier failed" is not a
    // finding, the runtime's own message is. `stage.ts` collapses newlines for
    // the same reason — a raw stderr dump breaks every Markdown table it lands
    // in.
    const e = err as { status?: number | null; signal?: string | null; stderr?: string | Buffer };
    const detail = String(e.stderr ?? (err instanceof Error ? err.message : err))
      .replace(/\s*[\r\n]+\s*/g, '; ')
      .trim()
      .slice(0, 2_000);
    return deadTier(
      config,
      tier,
      `the child process running this tier failed (exit ${String(e.status ?? 'none')}, signal ${String(e.signal ?? 'none')}): ${detail}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the ladder, honouring `config.isolation`.
 *
 * `'single-process'` is still reachable and still correct — it is what the unit
 * tests use, because spawning five vitest processes to check a table renders is
 * not a unit test. The mode is recorded on the result set either way, so a
 * reader always knows which regime produced a curve.
 */
export function runScalingSuiteForConfig(config: ScalingConfig): ScalingResult {
  if (config.isolation === 'single-process') return runScalingSuite(config);
  return runScalingSuite(config, { executeTier: runTierInChildProcess });
}
