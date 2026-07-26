/**
 * execute.ts
 *
 * One recorded run: release what the previous run left behind, read the memory
 * counters, drive the real pipeline, read them again, observe.
 *
 * WHY FORCED GC IS OPTIONAL AND NEVER A PASS CONDITION. `global.gc` exists only
 * under `--expose-gc`, which the project's normal vitest invocation does not
 * pass. Requiring it would mean the suites cannot run at all on a default
 * checkout — trading a real measurement for a tidier memory baseline, which is
 * the wrong way round. So the collection is attempted, whether it was possible
 * is RECORDED on every run, and a run without it is a valid run whose memory
 * figures carry more carry-over from its predecessor. That is a caveat a reader
 * can weigh; a suite that refuses to start is not.
 *
 * Runs are strictly sequential and synchronous. Nothing here is concurrent: two
 * pipelines in flight would share a CPU and an allocator, and every duration and
 * every RSS reading would then be a measurement of the scheduler.
 */

import { runOlvPipeline } from '../pipeline/runPipeline';
import type { TerrainConfig } from './config';
import { observeRun, type RunObservation } from './observe';

/** Node's memory counters, read defensively — a locked runtime may have none. */
interface MemorySnapshot {
  readonly rss: number | null;
  readonly heapUsed: number | null;
}

function readMemory(): MemorySnapshot {
  const p = (globalThis as { process?: { memoryUsage?: () => { rss: number; heapUsed: number } } })
    .process;
  if (typeof p?.memoryUsage !== 'function') return { rss: null, heapUsed: null };
  try {
    const usage = p.memoryUsage();
    return { rss: usage.rss, heapUsed: usage.heapUsed };
  } catch {
    // A runtime that refuses the call supplies no number. The observation
    // records null with a reason rather than a zero that reads as "no memory".
    return { rss: null, heapUsed: null };
  }
}

/** True when a collection was actually requested; false when none was possible. */
function releaseMemory(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') return false;
  try {
    gc();
    return true;
  } catch {
    return false;
  }
}

export interface ExecuteRunOptions {
  readonly index: number;
  readonly seed: number;
  readonly pointCount: number;
  readonly terrain: TerrainConfig;
  /**
   * Time the two isolated leaves. True for both suites: the scaling suite needs
   * the per-core curve, and the reproducibility suite needs the leaves' own
   * artifacts (the raster grid) in its hash comparison.
   */
  readonly isolateLeaves?: boolean;
}

/**
 * Run the pipeline once and observe it.
 *
 * The caller is responsible for having dropped its reference to the previous
 * run's observation-independent products before calling; this function releases
 * what it can and reads the counters immediately afterwards, so the "start RSS"
 * of run N is a post-collection baseline rather than run N−1's high-water mark.
 */
export function executeRun(options: ExecuteRunOptions): RunObservation {
  const forcedGcAvailable = releaseMemory();
  const before = readMemory();

  const run = runOlvPipeline({
    seed: options.seed,
    pointCount: options.pointCount,
    cellSizeM: options.terrain.cellSizeM,
    crs: options.terrain.crs,
    verticalDatum: options.terrain.verticalDatum,
    holdoutSeed: options.terrain.holdoutSeed,
    isolateLeaves: options.isolateLeaves ?? true,
  });

  const after = readMemory();
  return observeRun(run, {
    index: options.index,
    startRssBytes: before.rss,
    endRssBytes: after.rss,
    startHeapUsedBytes: before.heapUsed,
    endHeapUsedBytes: after.heapUsed,
    forcedGcAvailable,
  });
}
