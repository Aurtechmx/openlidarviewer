import {
  frustumPlanesFromViewProjection,
  boxInFrustum,
  nodeScore,
  depthCapForVelocity,
  projectedSize,
} from '../src/render/streaming/streamingScore';
import {
  streamingBudgets,
  selectWithinBudget,
} from '../src/render/streaming/streamingBudget';
import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../src/io/copc/copcChunkDecode';

/** Column-major identity matrix — clip space equals world space ([-1,1]³). */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A wide view: clip = world/256, so the frustum spans [-256,256]³. */
const WIDE = [
  1 / 256, 0, 0, 0,
  0, 1 / 256, 0, 0,
  0, 0, 1 / 256, 0,
  0, 0, 0, 1,
];

// --- streamingScore ----------------------------------------------------------

test('boxInFrustum culls a box outside the identity [-1,1] frustum', () => {
  const planes = frustumPlanesFromViewProjection(IDENTITY);
  expect(boxInFrustum([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5], planes)).toBe(true);
  expect(boxInFrustum([2, 2, 2, 3, 3, 3], planes)).toBe(false);
  // A box that fully contains the frustum still counts as visible.
  expect(boxInFrustum([-10, -10, -10, 10, 10, 10], planes)).toBe(true);
});

test('nodeScore is strictly coarse-first and respects the depth cap', () => {
  const shallow = nodeScore({ bounds: [0, 0, 0, 1, 1, 1], depth: 1, cameraPos: [0, 0, 5], depthCap: 10 });
  const deep = nodeScore({ bounds: [0, 0, 0, 1, 1, 1], depth: 4, cameraPos: [0, 0, 5], depthCap: 10 });
  expect(shallow).toBeGreaterThan(deep);
  // Past the cap → not loaded this tick.
  expect(nodeScore({ bounds: [0, 0, 0, 1, 1, 1], depth: 11, cameraPos: [0, 0, 5], depthCap: 10 })).toBe(0);
});

test('projectedSize grows as a box gets closer', () => {
  const near = projectedSize([0, 0, 0, 1, 1, 1], [0, 0, 2]);
  const far = projectedSize([0, 0, 0, 1, 1, 1], [0, 0, 50]);
  expect(near).toBeGreaterThan(far);
});

test('depthCapForVelocity shrinks the cap as the camera speeds up', () => {
  expect(depthCapForVelocity(18, 0)).toBe(18);
  expect(depthCapForVelocity(18, 20)).toBeLessThan(18);
  expect(depthCapForVelocity(18, 200)).toBeLessThan(depthCapForVelocity(18, 20));
});

// --- streamingBudget ---------------------------------------------------------

test('streamingBudgets scales with quality and device class', () => {
  expect(streamingBudgets('high', false).pointBudget).toBeGreaterThan(
    streamingBudgets('low', false).pointBudget,
  );
  expect(streamingBudgets('balanced', true).pointBudget).toBeLessThan(
    streamingBudgets('balanced', false).pointBudget,
  );
});

test('selectWithinBudget fills to the budget and always keeps the top node', () => {
  const sorted = [
    { id: 'a', pointCount: 800, score: 9 },
    { id: 'b', pointCount: 800, score: 8 },
    { id: 'c', pointCount: 800, score: 7 },
  ];
  expect(selectWithinBudget(sorted, 1700)).toEqual(new Set(['a', 'b']));
  // A budget smaller than even the first node still keeps that node.
  expect(selectWithinBudget(sorted, 100)).toEqual(new Set(['a']));
  // Zero-score candidates are never selected.
  expect(selectWithinBudget([{ id: 'z', pointCount: 1, score: 0 }], 1000).size).toBe(0);
});

// --- StreamingScheduler (synthetic COPC + fake decoder) ----------------------

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

/** Wait until the scheduler has no queued or in-flight work. */
async function drain(scheduler: StreamingScheduler): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = scheduler.stats();
    if (s.queued === 0 && s.loading === 0) return;
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
      { key: [2, 0, 0, 0], pointCount: 400 },
      { key: [2, 1, 0, 0], pointCount: 300 },
    ],
  });
  return StreamingPointCloud.open(new ArrayBufferRangeSource(fixture.buffer), 'sched.copc.laz');
}

test('the scheduler streams every visible node within budget', async () => {
  const cloud = await openCloud();
  const ready: StreamingNode[] = [];
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: (n) => ready.push(n), onNodeEvicted: () => {} },
    streamingBudgets('balanced', false),
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  expect(ready).toHaveLength(5);
  expect(cloud.counts().resident).toBe(5);
  expect(cloud.residentPointCount).toBe(3100);
});

test('shrinking the budget evicts the surplus resident nodes', async () => {
  const cloud = await openCloud();
  const evicted: StreamingNode[] = [];
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n) },
    streamingBudgets('balanced', false),
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(cloud.counts().resident).toBe(5);

  // A tiny budget keeps only the highest-priority (coarsest) node.
  scheduler.setBudgets({ pointBudget: 1000, maxConcurrentDecodes: 4 });
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  expect(evicted.length).toBe(4);
  expect(cloud.counts().resident).toBe(1);
  expect(cloud.residentPointCount).toBe(1000); // the depth-0 root node
});

test('a paused scheduler schedules no work', async () => {
  const cloud = await openCloud();
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    streamingBudgets('balanced', false),
  );
  scheduler.pause();
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(cloud.counts().resident).toBe(0);
});
