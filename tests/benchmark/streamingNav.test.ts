/**
 * streamingNav.test.ts — fast-navigation streaming measurement harness.
 *
 * WHAT THIS IS. A measurement, not a change. It drives the REAL
 * {@link StreamingScheduler} — the same scheduler the Viewer runs — through a
 * scripted fast camera navigation over a synthetic COPC octree, and records the
 * latencies the streaming path pays: per-node decode time, per-node queue wait,
 * first-render latency, the peak decoded-but-not-resident backlog, and the
 * scheduler's per-tick CPU cost. Nothing about scheduler admission, eviction,
 * commit or upload is touched; every number comes off a seam that already
 * exists — the source's `decodeMeta`/`readNodeChunk`, the decoder, and the
 * scheduler callbacks (`onNodeReady`, `onNodeEvicted`, `onTick`).
 *
 * WHY NODE-SIMULATED, NOT BROWSER-DRIVEN. Two of the requested components —
 * end-to-end frame time and mesh-creation / GPU-upload time — cannot be
 * observed here: a Node process has no render loop and no GL context. Rather
 * than fabricate them, the record marks them `unavailable` with a reason, and
 * `validateNavigationRecord` REFUSES a Node record that claims to have measured
 * either. The scheduler, decode queue and residency accounting, by contrast,
 * are pure TypeScript and run bit-for-bit as they do in the browser, so the
 * four scheduler-side latencies here are real measurements of the real code.
 * The device path that fills the two GPU-bound components is documented in
 * `docs/benchmarks.md` and sketched in `tests/e2e/streamingNavPerf.spec.ts`.
 *
 * DRIFT GUARD. The always-on test asserts the harness actually streamed
 * through the real scheduler (nodes went resident, ticks were timed) and that
 * the record passes the honesty validator. Set `STREAMING_NAV_WRITE=1` to run a
 * larger navigation and write the committed baseline to
 * `docs/validation/streaming-navigation-baseline.json`.
 */

import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildScaledSyntheticCopc } from '../fixtures/copc/scaledSynthCopc';
import { ArrayBufferRangeSource } from '../../src/io/range/ArrayBufferRangeSource';
import { StreamingPointCloud } from '../../src/render/streaming/StreamingPointCloud';
import {
  StreamingScheduler,
  decodedChunkBytes,
} from '../../src/render/streaming/StreamingScheduler';
import type { StreamingSource } from '../../src/render/streaming/StreamingSource';
import { streamingBudgets } from '../../src/render/streaming/streamingBudget';
import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../../src/io/copc/copcChunkDecode';
import {
  NavigationSamples,
  validateNavigationRecord,
  type LatencyComponent,
  type StreamingNavRecord,
} from '../../benchmarks/performance/streamingNavRecord';

/** Monotonic wall clock — the harness's own timing, in ms. */
const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** Estimated decoded bytes per point for the synthetic PDRF-6 chunk below. */
const EST_BYTES_PER_POINT = 12 /*pos*/ + 2 /*int*/ + 1 + 1 + 1 /*class/ret*/ + 8 /*gps*/;

/**
 * A representative decoder. Unlike the stress harness's instant decoder, this
 * allocates and writes the position buffer, so `decode` carries a real,
 * point-count-proportional CPU cost — which is what makes the decode-time
 * distribution a measurement rather than a row of zeros. Still deterministic:
 * no clock, no randomness, output derived from the point index alone.
 */
function representativeDecode(meta: ChunkDecodeMetadata): DecodedChunk {
  const n = meta.pointCount;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = (i % 997) * 1e-3;
    positions[i * 3] = v;
    positions[i * 3 + 1] = v * 0.5;
    positions[i * 3 + 2] = v * 0.25;
  }
  return {
    pointCount: n,
    positions,
    intensity: new Uint16Array(n),
    classification: new Uint8Array(n),
    returnNumber: new Uint8Array(n),
    returnCount: new Uint8Array(n),
    gpsTime: new Float64Array(n),
  };
}

/** A tiny deterministic PRNG (mulberry32) so the camera script is reproducible. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A column-major orthographic view-projection framing an axis-aligned window of
 * half-extent `half` centred at `target`. A node is in-frustum exactly when its
 * bounds overlap `[target ± half]` on every axis (verified against the
 * scheduler's Gribb–Hartmann extraction), so a small `half` sweeping across the
 * scene makes the WANTED SET move — which is what forces eviction and, on a
 * revisit inside the thrash window, re-request. A fixed wide frustum never
 * un-wants a node, so it can only ever exercise admission backpressure.
 */
function windowViewProjection(
  target: readonly [number, number, number],
  half: number,
): number[] {
  const s = 1 / half;
  const m = new Array<number>(16).fill(0);
  m[0] = s;
  m[5] = s;
  m[10] = s;
  m[15] = 1;
  m[12] = -target[0] * s; // row0 col3
  m[13] = -target[1] * s; // row1 col3
  m[14] = -target[2] * s; // row2 col3
  return m;
}

/** A dwell target scattered across the scene, plus the window half-extent. */
interface DwellTarget {
  readonly centre: [number, number, number];
  readonly half: number;
}

/**
 * Scatter `count` dwell targets across the scene bounds, and an order to visit
 * them that REVISITS an earlier target every few hops. The revisits land inside
 * the scheduler's 5 s thrash window (a hop is move+dwell ≈ 0.4 s), so a region
 * evicted after the 2 s defer window can be re-requested soon after — the
 * budget-boundary churn ("regions pulsing") the follow-on hardening targets.
 * Deterministic from `seed`.
 */
function dwellNavigation(
  bounds: readonly number[],
  count: number,
  seed: number,
): { targets: DwellTarget[]; order: number[] } {
  const rnd = mulberry32(seed);
  const cx = (bounds[0] + bounds[3]) / 2;
  const cy = (bounds[1] + bounds[4]) / 2;
  const cz = (bounds[2] + bounds[5]) / 2;
  const ex = (bounds[3] - bounds[0]) / 2;
  const ey = (bounds[4] - bounds[1]) / 2;
  const ez = (bounds[5] - bounds[2]) / 2;
  const span = Math.max(ex, ey, ez);
  // A window ~18 % of the extent per axis: the wanted set is a moving subset,
  // never the whole cube (a whole-cube frustum can only exercise admission, not
  // eviction, because nothing ever leaves the wanted set).
  const half = Math.max(1, span * 0.18);
  const targets: DwellTarget[] = [];
  for (let i = 0; i < count; i++) {
    targets.push({
      centre: [
        cx + (rnd() - 0.5) * ex * 1.6,
        cy + (rnd() - 0.5) * ey * 1.6,
        cz + (rnd() - 0.5) * ez * 1.6,
      ],
      half,
    });
  }
  const order: number[] = [];
  for (let i = 0; i < count; i++) {
    order.push(i);
    // Every third hop, revisit a target from a few hops back — within the
    // thrash window, so a just-evicted region reloads.
    if (i >= 3 && i % 3 === 0) order.push(i - 3);
  }
  return { targets, order };
}

/** A real delay so wall-clock advances — the eviction defer window is 2 s of it. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Linear interpolation between two points. */
function lerp3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Drain to quiescence at the end so the final counts settle. */
async function drain(scheduler: StreamingScheduler): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const s = scheduler.stats();
    if (s.queued === 0 && s.loading === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

export interface NavRunOptions {
  readonly targetPoints: number;
  readonly pointsPerNode: number;
  /** Dwell targets (hops) scattered across the scene. */
  readonly hops: number;
  readonly seed: number;
  readonly label: string;
  /**
   * Resident point budget as a fraction of the source point count. Below 1 the
   * whole scene cannot be resident at once, so a fast navigation forces the
   * scheduler to evict and re-request across the budget boundary — the
   * condition that produces queue waits, evictions and any thrash. Default 0.4.
   */
  readonly budgetFractionOfSource?: number;
  /**
   * Wall-clock a camera holds each dwell target, ms. It must exceed the
   * scheduler's 2 s eviction defer window across the run for eviction to fire —
   * the harness advances real time, it does not fake the clock. Default 320.
   */
  readonly dwellMs?: number;
  /** Real delay between scheduler ticks, ms (≈ a frame). Default 16. */
  readonly tickIntervalMs?: number;
}

/** The result of a run: the record plus the raw counters used to assert on it. */
export interface NavRunResult {
  readonly record: StreamingNavRecord;
  readonly sourcePoints: number;
  readonly nodeCount: number;
}

/**
 * Drive one scripted fast-navigation over the real scheduler and build a
 * {@link StreamingNavRecord}. Exported so an offline runner (or a future
 * browser harness reusing the record schema) can call it directly.
 */
export async function runStreamingNavigation(opts: NavRunOptions): Promise<NavRunResult> {
  const fixture = buildScaledSyntheticCopc({
    targetPoints: opts.targetPoints,
    pointsPerNode: opts.pointsPerNode,
  });
  const cloud = await StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    `${opts.label}.copc.laz`,
  );
  // Reuse a real preset for concurrency + cache sizing, but tighten the point
  // budget below the source so the fast navigation actually crosses the budget
  // boundary. Presets ('balanced' desktop = 2.5M points) sit far above a
  // test-tractable fixture, so at preset budget nothing is ever evicted and the
  // queue-wait / thrash the harness exists to see never occurs.
  const preset = streamingBudgets('balanced', false);
  const fraction = opts.budgetFractionOfSource ?? 0.4;
  const budgets = {
    ...preset,
    pointBudget: Math.max(50_000, Math.floor(cloud.sourcePointCount * fraction)),
  };
  const samples = new NavigationSamples();

  // Per-node bookkeeping, keyed by node id or by the (fresh) meta object the
  // wrapped source hands the decoder — the seam that lets a decode be tied
  // back to the node that dispatched it, without touching the scheduler.
  const firstQueuedAt = new Map<string, number>();
  const metaToNode = new Map<ChunkDecodeMetadata, { id: string; est: number }>();
  const evictedAt = new Map<string, number>();
  let inFlightBytes = 0;
  let decodedNotResidentBytes = 0;
  const THRASH_WINDOW_MS = 5_000;
  const t0 = now();

  // --- Source wrapper: intercept decodeMeta (dispatch) + readNodeChunk (fetch),
  //     pass everything else — including live getters — straight through. ---
  const wrappedSource = new Proxy(cloud as StreamingSource, {
    get(target, prop, _receiver) {
      if (prop === 'decodeMeta') {
        return (record: Parameters<StreamingSource['decodeMeta']>[0]): ChunkDecodeMetadata => {
          const meta = target.decodeMeta(record);
          const id = record.id;
          const est = record.pointCount * EST_BYTES_PER_POINT;
          // Queue-wait: dispatch time minus the tick it was first seen queued.
          // A node dispatched within the tick it was wanted was never observed
          // in the queue snapshot, so its wait is 0 — correct, not missing.
          const enqueued = firstQueuedAt.get(id);
          samples.pushQueueWaitMs(enqueued === undefined ? 0 : now() - enqueued);
          firstQueuedAt.delete(id);
          metaToNode.set(meta, { id, est });
          inFlightBytes += est;
          samples.observeInFlightDecodeBytes(inFlightBytes);
          return meta;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  // --- Decoder wrapper: time the real decode, and account decoded bytes as a
  //     not-yet-resident backlog until onNodeReady clears them. ---
  const decoder: ChunkDecoder = {
    decode: async (
      _chunk: ArrayBuffer,
      meta: ChunkDecodeMetadata,
      _signal?: AbortSignal,
    ): Promise<DecodedChunk> => {
      const started = now();
      const decoded = representativeDecode(meta);
      samples.pushDecodeMs(now() - started);
      const tracked = metaToNode.get(meta);
      if (tracked) {
        inFlightBytes = Math.max(0, inFlightBytes - tracked.est);
        const bytes = decodedChunkBytes(decoded);
        decodedNotResidentBytes += bytes;
        samples.observeDecodedNotResidentBytes(decodedNotResidentBytes);
        tracked.est = bytes; // reuse the slot to carry real decoded bytes to commit
      }
      return decoded;
    },
  };

  const scheduler = new StreamingScheduler(
    wrappedSource,
    decoder,
    {
      onNodeReady: (node) => {
        samples.noteFirstRender(now() - t0);
        samples.noteResident();
        const at = now();
        const prev = evictedAt.get(node.record.id);
        if (prev !== undefined) {
          evictedAt.delete(node.record.id);
          if (at - prev < THRASH_WINDOW_MS) samples.noteThrash();
        }
        // Clear this node's decoded-not-resident contribution: it is resident now.
        for (const [m, tracked] of metaToNode) {
          if (tracked.id === node.record.id) {
            decodedNotResidentBytes = Math.max(0, decodedNotResidentBytes - tracked.est);
            metaToNode.delete(m);
            break;
          }
        }
      },
      onNodeEvicted: (node) => {
        samples.noteEvicted();
        evictedAt.set(node.record.id, now());
      },
      onTick: (ms) => samples.pushTickMs(ms),
    },
    budgets,
  );

  // --- Drive the scripted fast navigation: hop between dwell targets, holding
  //     each long enough for wall-clock to cross the eviction defer window. ---
  const dwellMs = opts.dwellMs ?? 320;
  const tickIntervalMs = opts.tickIntervalMs ?? 16;
  const moveTicks = 4;
  const { targets, order } = dwellNavigation(cloud.localBounds(), opts.hops, opts.seed);
  const centre: [number, number, number] = [
    (cloud.localBounds()[0] + cloud.localBounds()[3]) / 2,
    (cloud.localBounds()[1] + cloud.localBounds()[4]) / 2,
    (cloud.localBounds()[2] + cloud.localBounds()[5]) / 2,
  ];
  let ticks = 0;
  let prev = centre;

  const tick = async (cam: [number, number, number], half: number): Promise<void> => {
    scheduler.update({ viewProjection: windowViewProjection(cam, half), cameraPosition: cam });
    ticks += 1;
    // Snapshot the queue: stamp the first tick each still-queued node is seen,
    // so its later dispatch yields a real, non-negative wait.
    const seenAt = now();
    for (const node of cloud.octree.store.queuedNodes()) {
      if (!firstQueuedAt.has(node.record.id)) firstQueuedAt.set(node.record.id, seenAt);
    }
    samples.observeResidentPoints(cloud.residentPointCount);
    await sleep(tickIntervalMs);
    samples.observeResidentPoints(cloud.residentPointCount);
  };

  for (const idx of order) {
    const target = targets[idx];
    // MOVE: a few fast ticks translating to the target — high velocity.
    for (let s = 1; s <= moveTicks; s++) {
      await tick(lerp3(prev, target.centre, s / moveTicks), target.half);
    }
    // DWELL: hold the target so velocity decays, the full budget unlocks and
    // deep nodes load — and so the 2 s evict window can elapse on regions left
    // behind.
    const dwellTicks = Math.max(1, Math.round(dwellMs / tickIntervalMs));
    for (let s = 0; s < dwellTicks; s++) await tick(target.centre, target.half);
    prev = target.centre;
  }
  await drain(scheduler);
  samples.observeResidentPoints(cloud.residentPointCount);
  const sessionMs = now() - t0;
  await cloud.close?.();

  const NO_FRAME_LOOP =
    'no render loop or GPU in this Node runtime; end-to-end frame time is captured on a real device';
  const NO_GL =
    'no GL context in this Node runtime; BufferGeometry build and GPU upload cannot be timed here';
  const frameTimeMs: LatencyComponent = { status: 'unavailable', reason: NO_FRAME_LOOP };
  const meshCreationMs: LatencyComponent = { status: 'unavailable', reason: NO_GL };

  const record = samples.finalize({
    label: opts.label,
    revision: gitRevision(),
    generatedAt: new Date().toISOString(),
    environment: {
      runtime: 'node',
      os: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      browser: null,
      backend: 'none',
    },
    workload: {
      datasetId: `${opts.label}.copc.laz`,
      sourcePoints: cloud.sourcePointCount,
      nodeCount: fixture.nodeCount,
      pointBudget: budgets.pointBudget,
      maxConcurrentDecodes: budgets.maxConcurrentDecodes,
      waypoints: opts.hops,
      ticks,
      seed: opts.seed,
    },
    sessionMs,
    frameTimeMs,
    meshCreationMs,
    notes: [
      'Node scheduler-drive: the StreamingScheduler, decode queue, residency and eviction run bit-for-bit as in the browser; nothing about their behaviour was altered.',
      'nodeDecodeMs measures the harness’s representative typed-array assembly, NOT laz-perf LAZ decompression; real per-node decode is heavier and is captured on device.',
      'frameTimeMs and meshCreationMs are unavailable here (no render loop, no GL); capture them on a real device via tests/e2e/streamingNavPerf.spec.ts.',
      'pointBudget is deliberately set below the source point count so the navigation crosses the budget boundary; at a preset budget nothing is evicted.',
      'peakDecodedNotResidentBytes ≈ one node on the immediate-commit path: decode→resident is atomic, so no decoded backlog accumulates. A metered-commit path would change this.',
    ],
  });

  return { record, sourcePoints: cloud.sourcePointCount, nodeCount: fixture.nodeCount };
}

/** The short git revision, or a clearly-marked fallback when git is unavailable. */
function gitRevision(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown-revision';
  }
}

const WRITE = process.env.STREAMING_NAV_WRITE === '1';

describe('streaming fast-navigation measurement harness', () => {
  test('drives the real scheduler and produces an honest, validated record', async () => {
    const { record } = await runStreamingNavigation({
      targetPoints: 300_000,
      pointsPerNode: 4_000,
      hops: 8,
      seed: 20260803,
      label: 'streaming-nav-contract',
      budgetFractionOfSource: 0.25,
      dwellMs: 300,
      tickIntervalMs: 12,
    });

    // It actually streamed through the real scheduler.
    expect(record.nodesResident).toBeGreaterThan(0);
    // And the eviction path engaged: the run spans several seconds, so regions
    // left behind cross the 2 s defer window. This guards the eviction seam.
    expect(record.nodesEvicted).toBeGreaterThan(0);
    expect(record.schedulerTickMs.status).toBe('measured');
    if (record.schedulerTickMs.status === 'measured') {
      expect(record.schedulerTickMs.samples.length).toBeGreaterThan(0);
    }

    // The measured latency components carry a real distribution.
    for (const comp of [record.nodeDecodeMs, record.queueWaitMs] as const) {
      expect(comp.status).toBe('measured');
      if (comp.status === 'measured') {
        expect(comp.samples.length).toBeGreaterThan(0);
        expect(comp.summary.p50).toBeGreaterThanOrEqual(0);
        expect(comp.summary.p95).toBeGreaterThanOrEqual(comp.summary.p50);
        expect(comp.summary.p99).toBeGreaterThanOrEqual(comp.summary.p95);
      }
    }
    expect(record.firstRenderMs.status).toBe('measured');

    // The GPU-bound components are honestly unavailable, never zero-filled.
    expect(record.frameTimeMs.status).toBe('unavailable');
    expect(record.meshCreationMs.status).toBe('unavailable');

    // Peak decoded-but-not-resident is measured (bytes ≥ 0; ~0 on the
    // immediate-commit path, which is the point of measuring it).
    expect(record.peakDecodedNotResidentBytes.status).toBe('measured');

    // The honesty validator accepts it.
    expect(validateNavigationRecord(record)).toEqual([]);
  }, 60_000);

  test('the validator rejects a Node record that fabricates frame time', () => {
    // A guard on the guard: prove the honesty check has teeth, so a future
    // edit that "fills in" frame time in Node fails loudly.
    const base = new NavigationSamples();
    base.pushDecodeMs(1);
    base.pushQueueWaitMs(0);
    base.pushTickMs(1);
    base.noteFirstRender(1);
    base.noteResident();
    const bad = base.finalize({
      label: 'bad',
      revision: 'deadbeef',
      generatedAt: new Date().toISOString(),
      environment: {
        runtime: 'node',
        os: 'test',
        architecture: 'test',
        nodeVersion: 'v0',
        browser: null,
        backend: 'none',
      },
      workload: {
        datasetId: 'bad',
        sourcePoints: 1,
        nodeCount: 1,
        pointBudget: 1,
        maxConcurrentDecodes: 1,
        waypoints: 1,
        ticks: 1,
        seed: 1,
      },
      sessionMs: 1,
      // A Node run cannot measure these; claiming to must be rejected.
      frameTimeMs: {
        status: 'measured',
        unit: 'ms',
        runtime: 'node',
        summary: { count: 1, mean: 16, p50: 16, p95: 16, p99: 16, max: 16 },
        samples: [16],
      },
      meshCreationMs: { status: 'unavailable', reason: 'x'.repeat(30) },
      notes: [],
    });
    expect(validateNavigationRecord(bad)).toContain('node-claims-frame-time');
  });

  test.runIf(WRITE)('writes the committed baseline', async () => {
    const { record } = await runStreamingNavigation({
      targetPoints: 1_000_000,
      pointsPerNode: 5_000,
      hops: 28,
      seed: 20260803,
      label: 'streaming-nav-baseline',
      budgetFractionOfSource: 0.35,
      dwellMs: 340,
      tickIntervalMs: 16,
    });
    expect(validateNavigationRecord(record)).toEqual([]);
    const here = dirname(fileURLToPath(import.meta.url));
    const out = resolve(here, '../../docs/validation/streaming-navigation-baseline.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    // Surface the headline numbers for the run log.
    // eslint-disable-next-line no-console
    console.log(`streaming-nav baseline written to ${out}`);
  }, 600_000);
});
