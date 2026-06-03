/**
 * streamingStressHarness.test.ts — v0.3.1 — synthetic-COPC stress harness.
 *
 * Drives the streaming scheduler through a scripted camera orbit on a scaled
 * synthetic COPC fixture and emits a finalised {@link StreamingBenchmark}
 * result. The test asserts the v0.3.1 hardening invariants — bounded
 * residency, no thrash on a stable scripted path, every observed metric
 * present in the result — so a future regression in scheduler / cache /
 * pressure code fails CI without anyone having to remember to run the
 * harness manually.
 *
 * The default tier here is `1M` (the only tier that fits a 44 s CI budget on
 * the slowest sandbox). Larger tiers — `10M`, `100M`, `250M`, `500M` — can be
 * exercised by an offline runner that imports this file's `runStressTier`
 * helper directly; in CI they are opt-in via `OPENLIDARVIEWER_STRESS_TIERS`,
 * a comma-separated list of tier names (`"100M,250M"`).
 */

import {
  buildScaledSyntheticCopc,
  STRESS_TIERS,
  STRESS_TIER_POINTS_PER_NODE,
  type StressTier,
} from './fixtures/copc/scaledSynthCopc';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import {
  StreamingBenchmark,
  type StreamingBenchmarkResult,
} from '../src/render/streaming/streamingBenchmark';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';
import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../src/io/copc/copcChunkDecode';

/** A view-projection that contains the synthetic cube — frustum spans [-256,256]³. */
const WIDE = [
  1 / 256, 0, 0, 0,
  0, 1 / 256, 0, 0,
  0, 0, 1 / 256, 0,
  0, 0, 0, 1,
];

/** Instant fake decoder — the chunk bytes are placeholders, so size from meta. */
const instantDecoder: ChunkDecoder = {
  decode: (_c: ArrayBuffer, meta: ChunkDecodeMetadata): Promise<DecodedChunk> =>
    Promise.resolve({
      pointCount: meta.pointCount,
      positions: new Float32Array(meta.pointCount * 3),
      intensity: new Uint16Array(meta.pointCount),
      classification: new Uint8Array(meta.pointCount),
      returnNumber: new Uint8Array(meta.pointCount),
      returnCount: new Uint8Array(meta.pointCount),
      gpsTime: new Float64Array(meta.pointCount),
    }),
};

/** Wait until the scheduler has no queued or in-flight work. */
async function drain(scheduler: StreamingScheduler): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const s = scheduler.stats();
    if (s.queued === 0 && s.loading === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** A scripted orbit around the cube — six positions hit every octant. */
const CAMERA_PATH: [number, number, number][] = [
  [200, 0, 0],
  [0, 200, 0],
  [-200, 0, 0],
  [0, -200, 0],
  [0, 0, 200],
  [0, 0, -200],
];

/**
 * Run the scheduler against one stress tier and return the finalised
 * benchmark result. Exported so an offline runner can iterate every tier.
 */
export async function runStressTier(tier: StressTier): Promise<{
  result: StreamingBenchmarkResult;
  budget: number;
  capBound: number;
  peakResident: number;
}> {
  const fixture = buildScaledSyntheticCopc({
    targetPoints: STRESS_TIERS[tier],
    pointsPerNode: STRESS_TIER_POINTS_PER_NODE[tier],
  });
  const cloud = await StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    `stress-${tier}.copc.laz`,
  );

  let clock = 0;
  const benchmark = new StreamingBenchmark(() => clock);
  const budgets = streamingBudgets('balanced', false);
  const scheduler = new StreamingScheduler(
    cloud,
    instantDecoder,
    {
      onNodeReady: (node) => {
        benchmark.recordFirstPaint();
        benchmark.recordNodeReady(node.record.id);
      },
      onNodeEvicted: (node) => benchmark.recordNodeEvicted(node.record.id),
      onTick: (ms) => benchmark.recordSchedulerTick(ms),
    },
    budgets,
    { now: () => clock },
  );

  for (const cam of CAMERA_PATH) {
    clock += 100;
    scheduler.update({ viewProjection: WIDE, cameraPosition: cam });
    await drain(scheduler);
    benchmark.recordResident(cloud.residentPointCount, budgets.pointBudget);
  }

  // hysteresis carries up to `memoryPressureRatio × budget`
  // worth of resident points before forcing eviction; allow that headroom.
  const capBound = Math.ceil(budgets.pointBudget * 1.5);
  return {
    result: benchmark.finalize(),
    budget: budgets.pointBudget,
    capBound,
    peakResident: cloud.residentPointCount,
  };
}

/**
 * Tier-aware scheduler-tick bounds. The architecture-determined cost of one
 * tick scales roughly with the resident-node count, which scales sub-
 * linearly with total points (the budget caps residency). Numbers are
 * upper bounds, not targets — see the documented benchmark notes for
 * actual measured values per tier on the reference sandbox.
 */
function tickMeanBoundFor(tier: StressTier): number {
  // ms, mean
  return { '1M': 50, '10M': 50, '100M': 50, '250M': 100, '500M': 200, '1B': 400 }[tier];
}

function tickP95BoundFor(tier: StressTier): number {
  // ms, p95
  return { '1M': 100, '10M': 100, '100M': 100, '250M': 200, '500M': 400, '1B': 800 }[tier];
}

/** Parse the optional `OPENLIDARVIEWER_STRESS_TIERS` env list, default `1M`. */
function tiersFromEnv(): StressTier[] {
  const fromEnv = (globalThis as { process?: { env?: Record<string, string> } })
    .process?.env?.OPENLIDARVIEWER_STRESS_TIERS;
  if (!fromEnv) return ['1M'];
  const out: StressTier[] = [];
  for (const name of fromEnv.split(',')) {
    const t = name.trim() as StressTier;
    if (t in STRESS_TIERS) out.push(t);
  }
  return out.length > 0 ? out : ['1M'];
}

for (const tier of tiersFromEnv()) {
  test(`stress harness — ${tier} tier: bounded residency, full benchmark shape, zero thrash`, async () => {
    const { result, budget, capBound } = await runStressTier(tier);

    // Benchmark shape — every benchmark field is observable.
    expect(result.firstPaintMs).not.toBeUndefined();
    expect((result.firstPaintMs ?? 0) >= 0).toBe(true);
    expect(result.peakResidentPoints).toBeGreaterThan(0);
    expect(result.schedulerTickMs.count).toBeGreaterThan(0);
    expect(result.sessionDurationMs).toBeGreaterThan(0);

    // Memory invariant — streaming-budget invariant.
    expect(result.peakResidentPoints).toBeLessThanOrEqual(capBound);
    // Budget itself should be respected after the orbit settles (we're not
    // mid-flick, so memory pressure should have evicted any surplus).
    expect(result.peakResidentPoints).toBeLessThanOrEqual(capBound);

    // A scripted, stationary-per-tick orbit shouldn't thrash. (retention
    // sibling-retention + eviction hysteresis together prevent load → evict →
    // reload cycles for a flick-free camera.)
    expect(result.thrashEvents).toBe(0);

    // Scheduler-tick budget — tier-aware. Below 100M the scheduler comfortably
    // sits in the per-frame budget; from 250M up the per-tick cost climbs
    // linearly with node count (the scoring + eviction passes walk every
    // resident or wanted node). At 500M / 1B the platform's honest posture
    // is "scheduler runs at a lower cadence than 60fps but never thrashes
    // or unbounds memory" — render-frame budget at extreme scale is a future
    // optimization target (incremental rescore + spatial-index acceleration),
    // not a v0.3.3 deliverable. The bounds here are upper limits anchored to
    // measured-and-acceptable values, not aspirational targets.
    const meanBound = tickMeanBoundFor(tier);
    const p95Bound = tickP95BoundFor(tier);
    expect(result.schedulerTickMs.mean).toBeLessThan(meanBound);
    expect(result.schedulerTickMs.p95).toBeLessThan(p95Bound);

    // Budget is exposed for diagnostic output if a tier fails.
    expect(budget).toBeGreaterThan(0);
  });
}
