/**
 * streamingEvictionChurn.test.ts — a measured ceiling on add/remove churn.
 *
 * The flicker this guards is only visible to a human in a browser, but the
 * churn underneath it is a number, and a number can be held to. This drives the
 * real scheduler over a fixed camera while the point budget steps up and down
 * across the memory-pressure trigger — the way a quality-preset change or an
 * FPS back-off moves it on a device — and counts how many nodes are evicted and
 * then asked back. Every one of those pairs is a decode and a fade the user did
 * not need to see.
 *
 * Deterministic by construction: an injected clock, a seeded budget script, and
 * a fake decoder. The count is stable to the unit across runs, so the ceiling
 * below is a real ratchet rather than a flake waiting to happen. On the code
 * this test arrived with it measures 12 479 pairs; the eviction path it
 * replaced measured 15 342.
 */

import { test, expect } from 'vitest';
import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';
import { DEFAULT_EVICTION_HYSTERESIS } from '../src/render/streaming/evictionPolicy';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildScaledSyntheticCopc } from './fixtures/copc/scaledSynthCopc';
import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../src/io/copc/copcChunkDecode';

/** A fake decoder — ignores the bytes, fabricates a chunk of the right size. */
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

/** A frustum wide enough to hold the whole scan, so nothing is ever culled. */
const WIDE = [
  1 / 4096, 0, 0, 0,
  0, 1 / 4096, 0, 0,
  0, 0, 1 / 4096, 0,
  0, 0, 0, 1,
];

const HIGH_BUDGET = 200_000;

/** A seeded [0,1) generator — mulberry32, so the budget script is portable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ChurnResult {
  readonly evictions: number;
  /** Nodes made resident again after being evicted — the churn. */
  readonly readmissions: number;
  readonly finalResidentPoints: number;
}

/** Drive one budget-oscillation run and count the churn. */
async function measureChurn(seed: number): Promise<ChurnResult> {
  const fixture = buildScaledSyntheticCopc({
    targetPoints: 400_000,
    pointsPerNode: 2_000,
  });
  const cloud = await StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'churn.copc.laz',
  );
  let clock = 0;
  let evictions = 0;
  let readmissions = 0;
  const evictedIds = new Set<string>();
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    {
      onNodeReady: (n) => {
        if (evictedIds.delete(n.record.id)) readmissions += 1;
      },
      onNodeEvicted: (n) => {
        evictions += 1;
        evictedIds.add(n.record.id);
      },
    },
    { ...streamingBudgets('balanced', false), pointBudget: HIGH_BUDGET },
    { now: () => clock },
  );

  const rnd = mulberry32(seed);
  for (let cycle = 0; cycle < 40; cycle++) {
    // Step down past the pressure trigger, then back up. The depth of the step
    // varies so the selection boundary lands somewhere different each cycle
    // rather than repeating one exact state.
    const low = Math.round(HIGH_BUDGET * (0.45 + rnd() * 0.2));
    for (const pointBudget of [low, HIGH_BUDGET]) {
      scheduler.setBudgets({ pointBudget, maxConcurrentDecodes: 4 });
      for (let tick = 0; tick < 12; tick++) {
        clock += 16;
        scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }
  return {
    evictions,
    readmissions,
    finalResidentPoints: cloud.residentPointCount,
  };
}

test('budget-pressure churn stays under its measured ceiling', async () => {
  const seeds = [20260803, 20260804, 20260805];
  const results: ChurnResult[] = [];
  for (const seed of seeds) results.push(await measureChurn(seed));

  const churn = results.reduce((n, r) => n + r.readmissions, 0);
  // Measured at 12 479 on the code this arrived with, against 15 342 for the
  // eviction path it replaced. The ceiling sits between the two with room for
  // ordinary drift, so a change that reverts the hysteresis fails here loudly
  // rather than quietly costing the user a re-fade per cycle.
  expect(churn).toBeGreaterThan(0);
  expect(churn).toBeLessThan(14_000);

  for (const r of results) {
    // Eviction genuinely ran, so the ceiling is not being met by doing nothing.
    expect(r.evictions).toBeGreaterThan(0);
    // And the budget is still respected at the end of the run: hysteresis
    // raised the floor eviction releases to, it did not remove the ceiling.
    expect(r.finalResidentPoints).toBeLessThanOrEqual(
      HIGH_BUDGET * DEFAULT_EVICTION_HYSTERESIS.triggerRatio,
    );
  }
}, 120_000);
