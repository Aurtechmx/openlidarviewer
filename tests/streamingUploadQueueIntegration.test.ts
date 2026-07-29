/**
 * Decode completion used to mark a node `resident` and build its mesh in the
 * same turn, so several decodes landing together built several meshes in one
 * frame. That is the hitch the upload queue exists to spread out.
 *
 * With a queue supplied, a decoded node waits in `decoded` — in memory, not
 * drawn — until the queue commits it. The distinction is the point:
 * `residentPointCount` then means points the user can see, so the budget
 * throttles against something real rather than against decode progress.
 *
 * The queue is opt-in, so the direct path is pinned here too.
 */

import { describe, expect, it } from 'vitest';

import { GpuUploadQueue } from '../src/render/gpuUploadQueue';
import { StreamingScheduler, decodedChunkBytes } from '../src/render/streaming/StreamingScheduler';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { ChunkDecoder, ChunkDecodeMetadata, DecodedChunk } from '../src/io/copc/copcChunkDecode';

const WIDE = [1/256,0,0,0, 0,1/256,0,0, 0,0,1/256,0, 0,0,0,1];

const fakeDecoder: ChunkDecoder = {
  async decode(_buf: ArrayBuffer, meta: ChunkDecodeMetadata): Promise<DecodedChunk> {
    return {
      pointCount: meta.pointCount,
      positions: new Float32Array(meta.pointCount * 3),
      intensity: new Uint16Array(meta.pointCount),
      classification: new Uint8Array(meta.pointCount),
      returnNumber: new Uint8Array(meta.pointCount),
      returnCount: new Uint8Array(meta.pointCount),
      gpsTime: new Float64Array(meta.pointCount),
    };
  },
};

async function drain(s: StreamingScheduler): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const st = s.stats();
    if (st.queued === 0 && st.loading === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function openCloud(): Promise<StreamingPointCloud> {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    nodes: [
      { key: [0, 0, 0, 0], pointCount: 1000 },
      { key: [1, 0, 0, 0], pointCount: 800 },
      { key: [1, 1, 0, 0], pointCount: 600 },
    ],
  });
  return StreamingPointCloud.open(new ArrayBufferRangeSource(fixture.buffer), 'queue.copc.laz');
}

function makeScheduler(cloud: StreamingPointCloud, ready: StreamingNode[], queue?: GpuUploadQueue) {
  return new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: (n) => ready.push(n), onNodeEvicted: () => {} },
    streamingBudgets('balanced', false),
    queue ? { uploadQueue: queue, datasetId: 'ds' } : {},
  );
}

describe('decoded-before-resident', () => {
  it('commits on decode when no queue is supplied', async () => {
    const cloud = await openCloud();
    const ready: StreamingNode[] = [];
    const s = makeScheduler(cloud, ready);
    s.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
    await drain(s);
    expect(ready).toHaveLength(3);
    expect(cloud.octree.store.decodedPendingPointCount).toBe(0);
    expect(cloud.octree.store.residentPointCount).toBeGreaterThan(0);
  });

  it('holds decoded nodes out of the resident count until the queue commits', async () => {
    const cloud = await openCloud();
    const ready: StreamingNode[] = [];
    const queue = new GpuUploadQueue();
    const s = makeScheduler(cloud, ready, queue);
    s.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
    await drain(s);

    // Decoded, queued, and deliberately not drawn.
    expect(ready).toHaveLength(0);
    expect(cloud.octree.store.residentPointCount).toBe(0);
    expect(cloud.octree.store.decodedPendingPointCount).toBe(2400);
    expect(queue.pendingCount).toBe(3);

    queue.process({ budgetMs: 1000 });

    expect(ready).toHaveLength(3);
    expect(cloud.octree.store.residentPointCount).toBe(2400);
    expect(cloud.octree.store.decodedPendingPointCount).toBe(0);
  });

  it('meters commits across frames instead of building every mesh at once', async () => {
    const cloud = await openCloud();
    const ready: StreamingNode[] = [];
    const queue = new GpuUploadQueue();
    const s = makeScheduler(cloud, ready, queue);
    s.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
    await drain(s);

    queue.process({ budgetMs: 1000, maxNodes: 1 });
    expect(ready).toHaveLength(1);
    expect(cloud.octree.store.decodedPendingPointCount).toBeGreaterThan(0);

    queue.process({ budgetMs: 1000, maxNodes: 1 });
    expect(ready).toHaveLength(2);

    queue.process({ budgetMs: 1000 });
    expect(ready).toHaveLength(3);
    expect(cloud.octree.store.decodedPendingPointCount).toBe(0);
  });

  it('a discarded node is never drawn and leaves no pending points', async () => {
    const cloud = await openCloud();
    const ready: StreamingNode[] = [];
    const queue = new GpuUploadQueue();
    const s = makeScheduler(cloud, ready, queue);
    s.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
    await drain(s);
    expect(cloud.octree.store.decodedPendingPointCount).toBe(2400);

    queue.clear(); // the scan was detached before anything committed

    expect(ready).toHaveLength(0);
    expect(cloud.octree.store.decodedPendingPointCount).toBe(0);
    expect(cloud.octree.store.residentPointCount).toBe(0);
    expect(queue.pendingBytes).toBe(0);
  });
});

describe('decodedChunkBytes', () => {
  it('sums the arrays the chunk actually carries', () => {
    const n = 100;
    const bytes = decodedChunkBytes({
      pointCount: n,
      positions: new Float32Array(n * 3),
      intensity: new Uint16Array(n),
      classification: new Uint8Array(n),
      returnNumber: new Uint8Array(n),
      returnCount: new Uint8Array(n),
      gpsTime: new Float64Array(n),
    });
    // 1200 + 200 + 100 + 100 + 100 + 800
    expect(bytes).toBe(2500);
  });

  it('counts optional attributes only when present', () => {
    const n = 10;
    const base = {
      pointCount: n,
      positions: new Float32Array(n * 3),
      intensity: new Uint16Array(n),
      classification: new Uint8Array(n),
      returnNumber: new Uint8Array(n),
      returnCount: new Uint8Array(n),
      gpsTime: new Float64Array(n),
    };
    const withRgb = decodedChunkBytes({ ...base, rgb: new Uint8Array(n * 3) });
    expect(withRgb - decodedChunkBytes(base)).toBe(30);
  });
});
