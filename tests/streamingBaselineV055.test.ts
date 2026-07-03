/**
 * streamingBaselineV055.test.ts — the v0.5.5 P0 deterministic scheduler
 * baseline (docs/_audit/v0.5.5-program.md §5 P0).
 *
 * Drives the UNCHANGED v0.5.4 StreamingScheduler through a scripted camera
 * path (orbit sweep → wheel-zoom dolly → rapid rotate → hard stop) over a
 * fixed-seed synthetic octree, with a mocked clock and an instant fake
 * decoder, recording per tick: visible candidates, resident node/point
 * counts, deepest resident depth, the effective depth cap, camera velocity,
 * stability, the concurrency/FPS budget factors, and cumulative
 * decode/eviction counts.
 *
 * Three contracts:
 *   1. DETERMINISM — two full runs produce identical traces.
 *   2. PIN — the trace equals the committed fixture
 *      (tests/fixtures/v055/schedulerBaseline.json). This is the v0.5.4
 *      selected-node baseline that P4's pixel-space scoring will be compared
 *      against; a diff here means scheduler behavior changed and must be a
 *      deliberate, reviewed decision.
 *   3. Sanity — the regulators demonstrably engaged during the run (motion
 *      halves concurrency; the stable fast path stops rescoring after stop).
 *
 * NOTE ON HONESTY: this scenario measures scheduler *decisions* in mocked
 * time. It records no wall-clock performance numbers — those come from the
 * maintainer's reference devices (see docs/_audit/v0.5.5-baseline/README.md).
 *
 * Regenerate the fixture (after a deliberate behavior change):
 *   UPDATE_V055_BASELINE=1 npx vitest run tests/streamingBaselineV055.test.ts
 * then commit the updated JSON with the change that explains it.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { depthCapForVelocity } from '../src/render/streaming/streamingScore';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import {
  baselineOctreeNodes,
  baselineCameraPath,
  BASELINE_SEED,
} from './fixtures/v055/cameraPath';
import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../src/io/copc/copcChunkDecode';

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/v055/schedulerBaseline.json',
);

/**
 * Mirrors the scheduler's private BASE_DEPTH_CAP (StreamingScheduler.ts).
 * Recorded so the trace pins the depth-cap arithmetic; at this fixture's
 * max depth (3) the velocity caps (−3/−6 levels off 18) never restrict
 * selection — they are pinned as values, not as selection changes.
 */
const BASE_DEPTH_CAP = 18;

/** Fixed budgets — independent of device-profile defaults. */
const BUDGETS = {
  pointBudget: 60_000,
  maxConcurrentDecodes: 4,
  chunkCacheBytes: 8 * 1024 * 1024,
};

/** Instant fake decoder — fabricates a chunk of the hierarchy's size. */
const fakeDecoder: ChunkDecoder = {
  decode(_chunk: ArrayBuffer, meta: ChunkDecodeMetadata): Promise<DecodedChunk> {
    return Promise.resolve({
      pointCount: meta.pointCount,
      positions: new Float32Array(meta.pointCount * 3),
      intensity: new Uint16Array(meta.pointCount),
      classification: new Uint8Array(meta.pointCount),
      returnNumber: new Uint8Array(meta.pointCount),
      returnCount: new Uint8Array(meta.pointCount),
      gpsTime: new Float64Array(meta.pointCount),
    });
  },
};

/** One recorded scheduler tick. */
interface TickRecord {
  phase: string;
  tick: number;
  tMs: number;
  visible: number;
  /** Queue depth after the drain — non-zero only if the pressure gate parked it. */
  queuedAfterDrain: number;
  residentNodes: number;
  residentPoints: number;
  maxResidentDepth: number;
  depthCap: number;
  cameraVelocity: number;
  isStable: boolean;
  effectiveMaxConcurrent: number;
  fpsBudgetFactor: number;
  pressureDepthReduction: number;
  decodesCumulative: number;
  evictionsCumulative: number;
  fullRescoreCount: number;
}

interface BaselineDocument {
  schema: string;
  seed: number;
  budgets: typeof BUDGETS;
  baseDepthCap: number;
  nodeCount: number;
  sourcePoints: number;
  trace: TickRecord[];
  /** Sorted resident-node id sets at the three reference cameras (P4 pin). */
  referenceCameras: Record<string, { tick: number; residentIds: string[] }>;
}

/** Wait until no decode is in flight (instant decoder → a few macrotasks). */
async function drainDecodes(scheduler: StreamingScheduler): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (scheduler.stats().loading === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('baseline drain did not settle within 500 turns');
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Run the full scripted scenario once and record the trace. */
async function runScenario(): Promise<BaselineDocument> {
  const nodes = baselineOctreeNodes();
  const fixture = buildSyntheticCopc({ center: [0, 0, 0], halfsize: 128, nodes });
  const cloud = await StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'v055-baseline.copc.laz',
  );

  let clock = 0;
  let decodes = 0;
  let evictions = 0;
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => decodes++, onNodeEvicted: () => evictions++ },
    BUDGETS,
    { now: () => clock },
  );

  const path = baselineCameraPath();
  const trace: TickRecord[] = [];
  const referenceCameras: BaselineDocument['referenceCameras'] = {};
  const lastTickOfPhase = new Map<string, number>();
  path.forEach((s, i) => lastTickOfPhase.set(s.phase, i));

  for (let tick = 0; tick < path.length; tick++) {
    const step = path[tick];
    clock = step.tMs;
    scheduler.update({
      viewProjection: step.viewProjection,
      cameraPosition: step.cameraPosition,
    });
    await drainDecodes(scheduler);

    const stats = scheduler.stats();
    const resident = cloud.octree.store.resident();
    let maxDepth = 0;
    for (const n of resident) {
      if (n.record.key.depth > maxDepth) maxDepth = n.record.key.depth;
    }
    trace.push({
      phase: step.phase,
      tick,
      tMs: step.tMs,
      visible: stats.visible,
      queuedAfterDrain: stats.queued,
      residentNodes: resident.length,
      residentPoints: cloud.octree.store.residentPointCount,
      maxResidentDepth: maxDepth,
      depthCap: depthCapForVelocity(
        BASE_DEPTH_CAP - stats.pressureDepthReduction,
        stats.cameraVelocity,
      ),
      cameraVelocity: round6(stats.cameraVelocity),
      isStable: stats.isStable,
      effectiveMaxConcurrent: stats.effectiveMaxConcurrent,
      fpsBudgetFactor: stats.fpsBudgetFactor,
      pressureDepthReduction: stats.pressureDepthReduction,
      decodesCumulative: decodes,
      evictionsCumulative: evictions,
      fullRescoreCount: stats.fullRescoreCount,
    });

    // The P4 selected-node pin: resident ids at each phase's final camera.
    if (lastTickOfPhase.get(step.phase) === tick) {
      referenceCameras[step.phase] = {
        tick,
        residentIds: resident.map((n) => n.record.id).sort(),
      };
    }
  }

  scheduler.stop();
  return {
    schema: 'openlidarviewer.v055-scheduler-baseline/1',
    seed: BASELINE_SEED,
    budgets: BUDGETS,
    baseDepthCap: BASE_DEPTH_CAP,
    nodeCount: nodes.length,
    sourcePoints: fixture.pointCount,
    trace,
    referenceCameras,
  };
}

describe('v0.5.5 P0 — deterministic scheduler baseline (v0.5.4 behavior pin)', () => {
  it('two full runs produce bit-identical traces (determinism)', async () => {
    const a = await runScenario();
    const b = await runScenario();
    expect(b).toEqual(a);
  }, 30_000);

  it('the trace matches the committed v0.5.4 baseline fixture (regression pin)', async () => {
    const doc = await runScenario();
    // Normalize through JSON so the comparison sees exactly what is on disk.
    const produced = JSON.parse(JSON.stringify(doc)) as BaselineDocument;

    if (process.env.UPDATE_V055_BASELINE === '1') {
      writeFileSync(FIXTURE_PATH, JSON.stringify(produced, null, 2) + '\n');
      console.log(`baseline fixture regenerated: ${FIXTURE_PATH}`);
      return;
    }

    expect(
      existsSync(FIXTURE_PATH),
      'fixture missing — run UPDATE_V055_BASELINE=1 vitest run tests/streamingBaselineV055.test.ts and commit it',
    ).toBe(true);
    const committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as BaselineDocument;
    expect(produced).toEqual(committed);
  }, 30_000);

  it('the pre-existing regulators demonstrably engaged during the run', async () => {
    const doc = await runScenario();
    const byPhase = (p: string): TickRecord[] => doc.trace.filter((t) => t.phase === p);

    // Fast rotation was classified as motion: concurrency halved, not stable.
    const rotating = byPhase('rotate-fast');
    expect(rotating.some((t) => t.cameraVelocity > 10)).toBe(true);
    expect(
      rotating.some((t) => t.effectiveMaxConcurrent < BUDGETS.maxConcurrentDecodes),
    ).toBe(true);

    // After the hard stop the camera settles: stable by the final tick, and
    // the stable-camera fast path stops full rescores (identical signature).
    const settle = byPhase('settle');
    const last = settle[settle.length - 1];
    expect(last.isStable).toBe(true);
    expect(last.cameraVelocity).toBe(0);
    expect(last.fullRescoreCount).toBe(settle[1].fullRescoreCount);

    // The budget actually bit — the source exceeds it, so selection chose.
    expect(doc.sourcePoints).toBeGreaterThan(BUDGETS.pointBudget);
    // Deferred/pressure eviction engaged at least once across the sweep.
    expect(last.evictionsCumulative).toBeGreaterThan(0);
  }, 30_000);
});
