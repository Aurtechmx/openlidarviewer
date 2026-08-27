/**
 * streamingFirstAdmission.test.ts
 *
 * The scheduler's pre-decode pressure gate carries an empty-viewer bypass: a
 * node is admitted regardless of projected residency while nothing is resident
 * yet, because refusing the only node that could ever become resident leaves
 * the viewer permanently blank. The bypass is necessary; being unbounded is
 * not. These tests pin both halves:
 *
 *   - a node above the absolute first-admission ceiling is refused by name,
 *     before any read or decode is dispatched;
 *   - a node the pressure cap alone would refuse still loads, so the bypass
 *     keeps doing the job it exists for;
 *   - a refusal skips one node rather than stalling the queue, so an
 *     admissible sibling in the same tick still reaches the screen.
 */

import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import {
  DECODED_BYTES_PER_POINT,
  streamingBudgets,
} from '../src/render/streaming/streamingBudget';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc, type SynthNode } from './fixtures/copc/synthCopc';
import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../src/io/copc/copcChunkDecode';

/** A wide view: clip = world/256, so the frustum spans [-256,256]³. */
const WIDE = [
  1 / 256, 0, 0, 0,
  0, 1 / 256, 0, 0,
  0, 0, 1 / 256, 0,
  0, 0, 0, 1,
];

/**
 * A decoder that records what it was asked to decode and returns an empty
 * chunk. Deliberately does NOT size its arrays by `meta.pointCount`: these
 * fixtures declare tens of millions of points, and the point of the test is
 * that the scheduler refuses before anything that large is allocated.
 */
function recordingDecoder(): { decoder: ChunkDecoder; seen: number[] } {
  const seen: number[] = [];
  const decoder: ChunkDecoder = {
    decode(_chunk: ArrayBuffer, meta: ChunkDecodeMetadata): Promise<DecodedChunk> {
      seen.push(meta.pointCount);
      return Promise.resolve({
        pointCount: 0,
        positions: new Float32Array(0),
        intensity: new Uint16Array(0),
        classification: new Uint8Array(0),
        returnNumber: new Uint8Array(0),
        returnCount: new Uint8Array(0),
        gpsTime: new Float64Array(0),
      });
    },
  };
  return { decoder, seen };
}

/** A decoder that reports every point the node declared, without allocating. */
function countingDecoder(): { decoder: ChunkDecoder; seen: number[] } {
  const seen: number[] = [];
  const decoder: ChunkDecoder = {
    decode(_chunk: ArrayBuffer, meta: ChunkDecodeMetadata): Promise<DecodedChunk> {
      seen.push(meta.pointCount);
      return Promise.resolve({
        pointCount: meta.pointCount,
        positions: new Float32Array(0),
        intensity: new Uint16Array(0),
        classification: new Uint8Array(0),
        returnNumber: new Uint8Array(0),
        returnCount: new Uint8Array(0),
        gpsTime: new Float64Array(0),
      });
    },
  };
  return { decoder, seen };
}

async function openCloud(nodes: SynthNode[]): Promise<StreamingPointCloud> {
  const fixture = buildSyntheticCopc({ center: [0, 0, 0], halfsize: 128, nodes });
  return StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'first-admission.copc.laz',
  );
}

/** Settle the scheduler's queued and in-flight work. */
async function drain(scheduler: StreamingScheduler): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = scheduler.stats();
    if (s.queued === 0 && s.loading === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

test('a first node above the absolute ceiling is refused before any decode', async () => {
  // 40 M points sits between the two downstream ceilings: under the COPC
  // decompressor's MAX_NODE_POINTS (50 M), so nothing further down refuses it,
  // and far past anything the resident budget could hold.
  const cloud = await openCloud([{ key: [0, 0, 0, 0], pointCount: 40_000_000 }]);
  const { decoder, seen } = recordingDecoder();
  const scheduler = new StreamingScheduler(
    cloud,
    decoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    { pointBudget: 2_500_000, maxConcurrentDecodes: 4, chunkCacheBytes: 1 << 20 },
  );

  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  // Nothing was read or decoded.
  expect(seen).toEqual([]);
  expect(cloud.counts().resident).toBe(0);

  const node = cloud.octree.store.get('0-0-0-0');
  expect(node?.state).toBe('error');
  expect(node?.error).toMatch(/first node/i);
  expect(node?.error).toContain('40000000');
});

test('the refusal is terminal — a later tick does not re-dispatch it', async () => {
  const cloud = await openCloud([{ key: [0, 0, 0, 0], pointCount: 40_000_000 }]);
  const { decoder, seen } = recordingDecoder();
  let clock = 0;
  const scheduler = new StreamingScheduler(
    cloud,
    decoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    { pointBudget: 2_500_000, maxConcurrentDecodes: 4, chunkCacheBytes: 1 << 20 },
    { now: () => clock },
  );

  for (let i = 0; i < 5; i++) {
    clock += 60_000; // past any retry backoff window
    scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
    await drain(scheduler);
  }

  expect(seen).toEqual([]);
  expect(cloud.octree.store.get('0-0-0-0')?.state).toBe('error');
});

test('the empty-viewer bypass still admits a first node the pressure cap alone would refuse', async () => {
  // This is the test that matters more than the guard: a 1000-point node
  // against a 100-point budget projects far past the 150-point pressure cap,
  // and must still load or the viewer is permanently blank.
  const cloud = await openCloud([{ key: [0, 0, 0, 0], pointCount: 1_000 }]);
  const { decoder, seen } = countingDecoder();
  const scheduler = new StreamingScheduler(
    cloud,
    decoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    { pointBudget: 100, maxConcurrentDecodes: 4, chunkCacheBytes: 1 << 20 },
  );

  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  expect(seen).toEqual([1_000]);
  expect(cloud.counts().resident).toBe(1);
  expect(cloud.octree.store.get('0-0-0-0')?.state).toBe('resident');
});

test('a node just under the ceiling is still admitted through the bypass', async () => {
  // 512 MiB of decoded arrays at DECODED_BYTES_PER_POINT. The boundary is
  // pinned from the test side so a future change to either the byte budget or
  // the per-point figure has to move this number deliberately.
  const ceiling = Math.floor((512 * 1024 * 1024) / DECODED_BYTES_PER_POINT);
  expect(ceiling).toBe(21_474_836);
  // Well past both the point budget and its 1.5x pressure cap, and past the
  // largest budget this viewer configures anywhere (desktop `high`, 8 M).
  expect(ceiling).toBeGreaterThan(streamingBudgets('high', false).pointBudget * 1.5);

  const cloud = await openCloud([{ key: [0, 0, 0, 0], pointCount: ceiling }]);
  const { decoder, seen } = countingDecoder();
  const scheduler = new StreamingScheduler(
    cloud,
    decoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    { pointBudget: 2_500_000, maxConcurrentDecodes: 4, chunkCacheBytes: 1 << 20 },
  );

  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  expect(seen).toEqual([ceiling]);
  expect(cloud.octree.store.get('0-0-0-0')?.state).toBe('resident');
});

test('a refused node releases its budget, so the nodes under it still load', async () => {
  // The pathological node is the coarsest, so it scores highest and takes the
  // whole point budget in `selectWithinBudget` — which is why refusing it is
  // not enough on its own. Once refused it has to leave the candidate set, or
  // the two admissible children are never wanted and the viewer is blank for a
  // file that is mostly fine.
  const cloud = await openCloud([
    { key: [0, 0, 0, 0], pointCount: 40_000_000 },
    { key: [1, 0, 0, 0], pointCount: 800 },
    { key: [1, 1, 0, 0], pointCount: 600 },
  ]);
  const { decoder, seen } = countingDecoder();
  const scheduler = new StreamingScheduler(
    cloud,
    decoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    { pointBudget: 2_500_000, maxConcurrentDecodes: 4, chunkCacheBytes: 1 << 20 },
  );

  // Two ticks: the refusal happens in the first tick's dispatch, and the
  // rescore that drops it from the candidate set runs at the head of the next.
  // The viewer drives `update` every animation frame, so this is one frame.
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  expect(seen.sort((a, b) => a - b)).toEqual([600, 800]);
  expect(cloud.counts().resident).toBe(2);
  expect(cloud.octree.store.get('0-0-0-0')?.state).toBe('error');
});
