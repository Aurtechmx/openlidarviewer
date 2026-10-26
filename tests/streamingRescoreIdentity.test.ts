/**
 * streamingRescoreIdentity.test.ts
 *
 * Pins what the scheduler's rescore decides on a 30k-node octree: the wanted
 * set (in the order selection built it), the queue order and the node scores,
 * tick by tick along the scripted camera path, with and without resident
 * stickiness. The digests below were recorded from the scheduler before its
 * rescore loop was tightened (cached local boxes, the indexed frustum test,
 * the enqueue walk that stops once every wanted node is seen), so any change
 * to a decision fails here.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { StreamingNodeStore } from '../src/render/streaming/StreamingNodeStore';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc, type SynthNode } from './fixtures/copc/synthCopc';
import { instantDecoder, scenarioCameraPath } from './fixtures/streaming/legacyBaselineScenario';
import { mulberry32 } from './support/mulberry32';

/** Every node to depth 4 (4,681) and a seeded ~70% of depth 5: about 30k nodes. */
function octreeNodes(): SynthNode[] {
  const rand = mulberry32(30_000);
  const nodes: SynthNode[] = [];
  for (let d = 0; d <= 5; d++) {
    const n = 1 << d;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        for (let z = 0; z < n; z++) {
          if (d === 5 && rand() >= 0.78) continue;
          nodes.push({ key: [d, x, y, z], pointCount: 20 + Math.floor(rand() * 60) });
        }
      }
    }
  }
  return nodes;
}

function readWantedIds(scheduler: StreamingScheduler, store: StreamingNodeStore): string[] {
  const seen: string[] = [];
  const real = store.get.bind(store);
  Object.defineProperty(store, 'get', {
    configurable: true,
    writable: true,
    value: (id: string) => {
      seen.push(id);
      return real(id);
    },
  });
  try {
    scheduler.readinessFacts();
  } finally {
    delete (store as unknown as Record<string, unknown>).get;
  }
  return seen;
}

async function record(stickyMargin: number): Promise<{ nodes: number; digest: string; wantedTotal: number }> {
  const fixture = buildSyntheticCopc({ center: [0, 0, 0], halfsize: 128, nodes: octreeNodes() });
  const cloud = await StreamingPointCloud.open(new ArrayBufferRangeSource(fixture.buffer), 'rescore.copc.laz');
  const store = cloud.octree.store;
  const queued: string[] = [];
  const realSetState = store.setState.bind(store);
  Object.defineProperty(store, 'setState', {
    configurable: true,
    writable: true,
    value: (node: StreamingNode, state: Parameters<StreamingNodeStore['setState']>[1], points = 0) => {
      if (state === 'queued') queued.push(node.record.id);
      return realSetState(node, state, points);
    },
  });
  let clock = 0;
  const scheduler = new StreamingScheduler(
    cloud,
    instantDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    { pointBudget: 60_000, maxConcurrentDecodes: 6, chunkCacheBytes: 16 * 1024 * 1024 },
    { now: () => clock, stickyMargin },
  );
  const cube = cloud.localBounds();
  const halfSpan = Math.max(cube[3] - cube[0], cube[4] - cube[1], cube[5] - cube[2]) / 2;
  const centre: [number, number, number] = [(cube[0] + cube[3]) / 2, (cube[1] + cube[4]) / 2, (cube[2] + cube[5]) / 2];
  const hash = createHash('sha256');
  let wantedTotal = 0;
  let queuedTotal = 0;
  let residentMax = 0;
  for (const step of scenarioCameraPath(halfSpan, centre)) {
    clock = step.tMs;
    queued.length = 0;
    scheduler.update({ viewProjection: step.viewProjection, cameraPosition: step.cameraPosition });
    const wanted = readWantedIds(scheduler, store);
    wantedTotal += wanted.length;
    queuedTotal += queued.length;
    hash.update(`W${wanted.join(',')}\nQ${queued.join(',')}\n`);
    for (const node of store.iterate()) if (node.score > 0) hash.update(`${node.record.id}=${node.score};`);
    // Let the instant decodes land so later ticks see residents.
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    residentMax = Math.max(residentMax, store.resident().length);
  }
  if (process.env.RESCORE_STATS) console.log('nodes', store.size, 'wanted', wantedTotal, 'queued', queuedTotal, 'residentMax', residentMax, 'scheduler', JSON.stringify(scheduler.stats()));
  return { nodes: store.size, digest: hash.digest('hex'), wantedTotal };
}

describe('scheduler rescore on a 30k-node octree', () => {
  it('keeps the wanted sets, queue order and scores without stickiness', async () => {
    const r = await record(0);
    expect(r.nodes).toBeGreaterThan(29_000);
    expect(r.wantedTotal).toBeGreaterThan(0);
    expect(r.digest).toBe('5ad2451dd230d7e7993804dd89c3ff0e077f489652947ef9dc695f9613df17f8');
  }, 120_000);

  it('keeps the wanted sets, queue order and scores with resident stickiness', async () => {
    const r = await record(0.15);
    expect(r.digest).toBe('8cb2a45d27558a047c595508a9796b4ffe2e36c7a3b9df1fa7a29ce2f1dd4440');
  }, 120_000);
});
