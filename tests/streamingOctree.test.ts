import { StreamingNodeStore } from '../src/render/streaming/StreamingNodeStore';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import type { StreamingNodeRecord } from '../src/io/copc/copcTypes';

function record(id: string, pointCount: number): StreamingNodeRecord {
  return {
    id,
    key: { depth: 0, x: 0, y: 0, z: 0 },
    bounds: [0, 0, 0, 1, 1, 1],
    pointCount,
    byteOffset: 1000,
    byteSize: 200,
    spacing: 1,
  };
}

// --- StreamingNodeStore ------------------------------------------------------

test('StreamingNodeStore.add is idempotent by id', () => {
  const store = new StreamingNodeStore();
  const a = store.add(record('n1', 100));
  const b = store.add(record('n1', 999));
  expect(a).toBe(b);
  expect(store.size).toBe(1);
});

test('StreamingNodeStore tracks resident points exactly across transitions', () => {
  const store = new StreamingNodeStore();
  const n = store.add(record('n1', 500));
  expect(store.residentPointCount).toBe(0);

  store.setState(n, 'queued');
  store.setState(n, 'loading');
  store.setState(n, 'resident', 480);
  expect(store.residentPointCount).toBe(480);
  expect(store.counts().resident).toBe(1);

  // Evicting a resident node returns its points to the budget.
  store.setState(n, 'unloaded');
  expect(store.residentPointCount).toBe(0);
});

test('StreamingNodeStore.counts and setError report lifecycle state', () => {
  const store = new StreamingNodeStore();
  const a = store.add(record('a', 10));
  const b = store.add(record('b', 20));
  store.setState(a, 'queued');
  store.setError(b, 'decode failed');
  const counts = store.counts();
  expect(counts).toEqual({ known: 2, queued: 1, loading: 0, resident: 0, error: 1 });
  expect(b.error).toBe('decode failed');
});

test('StreamingNodeStore maintained resident/queued sets match a ground-truth walk', () => {
  // Guards the v0.4.6 perf fix: the scheduler walks `residentNodes()` /
  // `queuedNodes()` every tick instead of `all().filter(...)` over the whole
  // 28 k-node hierarchy. The maintained sets must stay bit-identical to a full
  // walk across every transition, or the scheduler would evict/reconsider the
  // wrong nodes.
  const store = new StreamingNodeStore();
  const nodes = Array.from({ length: 50 }, (_, i) => store.add(record(`n${i}`, 100 + i)));

  const walkResident = (): Set<unknown> =>
    new Set(store.all().filter((n) => n.state === 'resident'));
  const walkQueued = (): Set<unknown> =>
    new Set(store.all().filter((n) => n.state === 'queued'));
  const setMatchesWalk = (): void => {
    expect(new Set(store.residentNodes())).toEqual(walkResident());
    expect(new Set(store.queuedNodes())).toEqual(walkQueued());
    expect([...store.residentNodes()].length).toBe(store.counts().resident);
    expect([...store.queuedNodes()].length).toBe(store.queuedCount);
  };

  setMatchesWalk(); // empty
  // Drive a realistic lifecycle churn over a subset.
  for (let i = 0; i < nodes.length; i += 2) store.setState(nodes[i], 'queued');
  setMatchesWalk();
  for (let i = 0; i < nodes.length; i += 4) store.setState(nodes[i], 'loading');
  setMatchesWalk();
  for (let i = 0; i < nodes.length; i += 4) store.setState(nodes[i], 'resident', 200);
  setMatchesWalk();
  // Evict some residents, re-queue some others, error one — all paths.
  store.setState(nodes[0], 'unloaded');
  store.setState(nodes[8], 'unloaded');
  store.setState(nodes[12], 'queued');
  store.setError(nodes[16], 'boom');
  setMatchesWalk();

  // iterate() yields every known node with zero filtering.
  expect([...store.iterate()].length).toBe(store.size);
  expect(new Set(store.iterate())).toEqual(new Set(store.all()));
});

// --- StreamingOctree + StreamingPointCloud -----------------------------------

test('StreamingPointCloud.open ingests a single-page hierarchy', async () => {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    nodes: [
      { key: [0, 0, 0, 0], pointCount: 1000 },
      { key: [1, 0, 0, 0], pointCount: 400 },
    ],
  });
  const cloud = await StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'test.copc.laz',
  );
  expect(cloud.octree.nodes()).toHaveLength(2);
  expect(cloud.sourcePointCount).toBe(1400);
  expect(cloud.maxDepth()).toBe(1);
  expect(cloud.localBounds()).toEqual([-128, -128, -128, 128, 128, 128]);
  expect(cloud.octree.errors).toEqual([]);
});

test('StreamingOctree loads child pages and resolves parent/child links', async () => {
  const fixture = buildSyntheticCopc({
    pages: [
      {
        pageKey: [0, 0, 0, 0],
        nodes: [{ key: [0, 0, 0, 0], pointCount: 2000 }],
        childPages: [1],
      },
      {
        pageKey: [1, 0, 0, 0],
        nodes: [
          { key: [1, 0, 0, 0], pointCount: 800 },
          { key: [1, 1, 0, 0], pointCount: 600 },
        ],
      },
    ],
  });
  const cloud = await StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'multi.copc.laz',
  );
  expect(cloud.octree.fullyLoaded).toBe(true);
  expect(cloud.octree.nodes()).toHaveLength(3);

  const root = cloud.octree.store.get('0-0-0-0');
  expect(root).toBeDefined();
  expect(new Set(root!.childIds)).toEqual(new Set(['1-0-0-0', '1-1-0-0']));
  expect(cloud.octree.childrenOf(root!).map((n) => n.record.id).sort()).toEqual([
    '1-0-0-0',
    '1-1-0-0',
  ]);
  expect(cloud.octree.rootNodes()).toHaveLength(1);
});
