import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import type { SynthNode } from './fixtures/copc/synthCopc';
import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../src/io/copc/copcChunkDecode';

/** A wide view whose frustum spans [-256,256]³ — sees the whole synthetic cube. */
const WIDE = [
  1 / 256, 0, 0, 0,
  0, 1 / 256, 0, 0,
  0, 0, 1 / 256, 0,
  0, 0, 0, 1,
];

/** A fake decoded chunk of `n` points. */
function fakeChunk(n: number): DecodedChunk {
  return {
    pointCount: n,
    positions: new Float32Array(n * 3),
    intensity: new Uint16Array(n),
    classification: new Uint8Array(n),
    returnNumber: new Uint8Array(n),
    returnCount: new Uint8Array(n),
    gpsTime: new Float64Array(n),
  };
}

/** An instant fake decoder. */
const instantDecoder: ChunkDecoder = {
  decode: (_c: ArrayBuffer, meta: ChunkDecodeMetadata): Promise<DecodedChunk> =>
    Promise.resolve(fakeChunk(meta.pointCount)),
};

/** Generate a large multi-depth octree of synthetic nodes. */
function bigHierarchy(): SynthNode[] {
  const nodes: SynthNode[] = [{ key: [0, 0, 0, 0], pointCount: 50_000 }];
  for (let d = 1; d <= 4; d++) {
    const max = 2 ** d;
    const step = Math.max(1, Math.floor(max / 5));
    for (let x = 0; x < max; x += step) {
      for (let y = 0; y < max; y += step) {
        for (let z = 0; z < max; z += step) {
          nodes.push({ key: [d, x, y, z], pointCount: 50_000 });
        }
      }
    }
  }
  return nodes;
}

async function openBig(): Promise<StreamingPointCloud> {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    nodes: bigHierarchy(),
  });
  return StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'stress.copc.laz',
  );
}

async function drain(scheduler: StreamingScheduler): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const s = scheduler.stats();
    if (s.queued === 0 && s.loading === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

test('a large hierarchy stays within the point budget — bounded memory', async () => {
  const cloud = await openBig();
  expect(cloud.octree.nodes().length).toBeGreaterThan(300);

  const budgets = streamingBudgets('low', false);
  const scheduler = new StreamingScheduler(
    cloud,
    instantDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    budgets,
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  // Far more source points exist than the budget — residency must be bounded.
  expect(cloud.sourcePointCount).toBeGreaterThan(budgets.pointBudget);
  expect(cloud.residentPointCount).toBeGreaterThan(0);
  expect(cloud.residentPointCount).toBeLessThanOrEqual(budgets.pointBudget);
});

test('rapid camera movement keeps residency bounded and never crashes', async () => {
  const cloud = await openBig();
  const budgets = streamingBudgets('balanced', false);
  const scheduler = new StreamingScheduler(
    cloud,
    instantDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    budgets,
  );
  // Jump the camera around — each update reprioritises and re-evicts.
  for (const cam of [
    [0, 0, 0],
    [200, 0, 0],
    [-150, 120, 60],
    [0, -200, -80],
    [80, 80, 80],
  ] as [number, number, number][]) {
    scheduler.update({ viewProjection: WIDE, cameraPosition: cam });
    await drain(scheduler);
    expect(cloud.residentPointCount).toBeLessThanOrEqual(budgets.pointBudget);
  }
});

test('scheduler.stop cancels in-flight decodes — nothing is left resident', async () => {
  const cloud = await openBig();
  // A deferred decoder so requests are genuinely in flight when stop() lands.
  const deferred: ChunkDecoder = {
    decode: (_c, meta, signal): Promise<DecodedChunk> =>
      new Promise<DecodedChunk>((resolve, reject) => {
        const timer = setTimeout(() => resolve(fakeChunk(meta.pointCount)), 50);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      }),
  };
  const scheduler = new StreamingScheduler(
    cloud,
    deferred,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    streamingBudgets('low', false),
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  scheduler.stop(); // abort everything mid-flight
  await new Promise((r) => setTimeout(r, 90));
  expect(cloud.counts().resident).toBe(0);
});
