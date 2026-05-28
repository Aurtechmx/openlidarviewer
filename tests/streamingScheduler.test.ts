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

// --- eviction hysteresis -----------------------------------

test('hysteresis defers eviction within the configured window', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const evicted: StreamingNode[] = [];
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n) },
    streamingBudgets('balanced', false),
    // memoryPressureRatio: huge → disables the override path so we test
    // the pure-hysteresis branch.
    { now: () => clock, evictDeferMs: 1_000, memoryPressureRatio: 1_000 },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(cloud.counts().resident).toBe(5);

  // Shrink the budget. With memory pressure disabled, the unwanted nodes
  // are marked for deferred eviction but stay resident through the window.
  scheduler.setBudgets({ pointBudget: 1_000, maxConcurrentDecodes: 4 });
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(evicted).toHaveLength(0);
  expect(cloud.counts().resident).toBe(5);
});

test('hysteresis evicts unwanted, unprotected nodes once the window lapses', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const evicted: StreamingNode[] = [];
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n) },
    streamingBudgets('balanced', false),
    { now: () => clock, evictDeferMs: 1_000, memoryPressureRatio: 1_000 },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  scheduler.setBudgets({ pointBudget: 1_000, maxConcurrentDecodes: 4 });
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  // Advance past the defer window — unprotected unwanted nodes evict now.
  clock = 1_500;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(evicted.length).toBeGreaterThan(0);
});

test('a node re-entering the wanted set cancels its pending eviction', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const evicted: StreamingNode[] = [];
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n) },
    streamingBudgets('balanced', false),
    { now: () => clock, evictDeferMs: 1_000, memoryPressureRatio: 1_000 },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  // Shrink (defer) → restore budget → advance past the window: every node
  // is back in the wanted set, so the deferred markers were cleared and
  // nothing evicts.
  scheduler.setBudgets({ pointBudget: 1_000, maxConcurrentDecodes: 4 });
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  scheduler.setBudgets({ pointBudget: 1_000_000, maxConcurrentDecodes: 4 });
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  clock = 2_000;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(evicted).toHaveLength(0);
  expect(cloud.counts().resident).toBe(5);
});

test('memory pressure evicts deferred nodes immediately, bypassing hysteresis', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const evicted: StreamingNode[] = [];
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n) },
    streamingBudgets('balanced', false),
    // Default 1.5× ratio is plenty — 5 nodes × ~600 pts = 3100 points,
    // 1000-point budget × 1.5 = 1500 < 3100 → memory pressure triggers.
    { now: () => clock, evictDeferMs: 10_000 },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(cloud.counts().resident).toBe(5);

  // Shrink to a tiny budget. The hysteresis window is 10 s but the override
  // fires this tick — clock hasn't advanced.
  scheduler.setBudgets({ pointBudget: 1_000, maxConcurrentDecodes: 4 });
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(evicted.length).toBe(4);
  expect(cloud.counts().resident).toBe(1);
});

test('a parent of a resident node is never evicted before the child', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const evicted: StreamingNode[] = [];
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n) },
    streamingBudgets('balanced', false),
    { now: () => clock, evictDeferMs: 500, memoryPressureRatio: 1_000 },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  // Shrink to one node, advance past the window. Children at depth 2 evict
  // first; their depth-1 parents follow only on the NEXT tick, when the
  // protection set no longer includes them.
  scheduler.setBudgets({ pointBudget: 1_000, maxConcurrentDecodes: 4 });
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  clock = 800;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  // After one post-deadline tick the unprotected leaves drop, but the
  // depth-1 parent (1,0,0,0) — whose children (2,0,0,0) and (2,1,0,0) were
  // resident when the protection snapshot was taken — must survive this
  // tick regardless of its expired deadline.
  const evictedKeys = evicted.map((n) => n.record.key);
  // Both depth-2 leaves got dropped (they had no protection).
  expect(evictedKeys.some((k) => k.depth === 2 && k.x === 0)).toBe(true);
  expect(evictedKeys.some((k) => k.depth === 2 && k.x === 1)).toBe(true);
  // The parent of the resident leaves stayed put — protection held.
  expect(
    evictedKeys.find((k) => k.depth === 1 && k.x === 0 && k.y === 0 && k.z === 0),
  ).toBeUndefined();
});

// --- camera-motion awareness -------------------------------

test('smoothed camera velocity tracks linear motion across multiple ticks', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    streamingBudgets('balanced', false),
    { now: () => clock },
  );
  // The first tick seeds `_lastCameraPos` — no velocity sample yet.
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  expect(scheduler.stats().cameraVelocity).toBe(0);

  // Step the camera 10 world units every 100 ms — a steady 100 u/s signal.
  // The EWMA (τ = 200 ms ⇒ α = 0.5 at dt = 100 ms) chases the true value:
  // 0 → 50 → 75 → 87.5 → 93.75 → 96.875 → 98.4375.
  for (let i = 1; i <= 6; i++) {
    clock = i * 100;
    scheduler.update({ viewProjection: WIDE, cameraPosition: [i * 10, 0, 0] });
  }
  const v = scheduler.stats().cameraVelocity;
  expect(v).toBeGreaterThan(95);
  expect(v).toBeLessThanOrEqual(100);
});

test('fast camera motion classifies isStable=false and halves concurrency', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const budgets = streamingBudgets('balanced', false); // maxConcurrentDecodes = 4
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    budgets,
    { now: () => clock },
  );
  // Establish a settled stationary baseline so the next tick's classification
  // can only be explained by camera motion, not first-tick startup.
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  clock = 1_000;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  const stable = scheduler.stats();
  expect(stable.isStable).toBe(true);
  expect(stable.effectiveMaxConcurrent).toBe(budgets.maxConcurrentDecodes);

  // Now move fast — 50 units over 100 ms ⇒ 500 u/s, well above 10 u/s.
  clock = 1_100;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [50, 0, 0] });
  const moving = scheduler.stats();
  expect(moving.cameraVelocity).toBeGreaterThan(10);
  expect(moving.isStable).toBe(false);
  expect(moving.effectiveMaxConcurrent).toBe(
    Math.max(1, Math.floor(budgets.maxConcurrentDecodes * 0.5)),
  );
});

test('concurrency returns to full after the settle window elapses', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const budgets = streamingBudgets('balanced', false);
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    budgets,
    { now: () => clock },
  );
  // Move fast first so the scheduler is in the throttled regime.
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  clock = 100;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [50, 0, 0] });
  expect(scheduler.stats().isStable).toBe(false);
  expect(scheduler.stats().effectiveMaxConcurrent).toBeLessThan(
    budgets.maxConcurrentDecodes,
  );

  // Stop. A big dt (1.4 s) makes EWMA α = 1, so the smoothed velocity snaps
  // to 0 and `_stableSinceTs` is armed *this* tick. The settle window has not
  // elapsed yet — concurrency is still throttled.
  clock = 1_500;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [50, 0, 0] });
  expect(scheduler.stats().isStable).toBe(false);
  expect(scheduler.stats().effectiveMaxConcurrent).toBeLessThan(
    budgets.maxConcurrentDecodes,
  );

  // One more still tick, > 250 ms later — the camera is now classified
  // stable and the full concurrent-decode budget is restored.
  clock = 2_000;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [50, 0, 0] });
  const settled = scheduler.stats();
  expect(settled.cameraVelocity).toBe(0);
  expect(settled.isStable).toBe(true);
  expect(settled.effectiveMaxConcurrent).toBe(budgets.maxConcurrentDecodes);
});

// --- hierarchy-aware eviction -----------------------------

test('sibling retention defers eviction when a sibling stays in the wanted set', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const evicted: StreamingNode[] = [];
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n) },
    streamingBudgets('balanced', false),
    { now: () => clock, evictDeferMs: 500, memoryPressureRatio: 1_000 },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(cloud.counts().resident).toBe(5);

  // selectWithinBudget walks candidates in score order — within a depth,
  // higher projected-size wins. At camera=[0,0,0] this puts (2,1,0,0)
  // (closer, dist≈139) ahead of (2,0,0,0) (further, dist≈166), so a
  // budget that includes one depth-2 child picks (2,1,0,0). Budget 2800
  // gives wanted = {root, (1,0,0,0), (1,1,0,0), (2,1,0,0)} and leaves
  // (2,0,0,0) as the sole unwanted node — and its sibling (2,1,0,0) is
  // wanted under the same parent (1,0,0,0), so sibling-retention fires.
  scheduler.setBudgets({ pointBudget: 2_800, maxConcurrentDecodes: 4 });
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  // Advance well past the deferral window. Without sibling-retention both
  // unwanted nodes would evict here; with it, their deadlines re-arm.
  clock = 800;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(evicted).toHaveLength(0);
  expect(cloud.counts().resident).toBe(5);
});

test('deepest-and-furthest deferred nodes evict first when multiple lapse together', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const evicted: StreamingNode[] = [];
  // Camera at +X — the negative-X octants are objectively further away,
  // so (2,0,0,0) (centre ≈ [-96,-96,-96]) outranks (2,1,0,0)
  // (centre ≈ [-32,-96,-96]) for furthest-first eviction.
  const farCam: [number, number, number] = [200, 0, 0];
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n) },
    streamingBudgets('balanced', false),
    { now: () => clock, evictDeferMs: 500, memoryPressureRatio: 1_000 },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: farCam });
  await drain(scheduler);

  // Budget 1000 (= root's point count) leaves only root in the wanted set:
  // adding any depth-1 node would overflow. wantedParentKeys is then empty
  // (root has no parent), so no node gets sibling-retention. The memory-
  // pressure threshold here is 1000 × 1000 = 1 M, well above the resident
  // count, so the override path stays dormant and the lapsed loop alone
  // does the evictions — letting us assert its ordering.
  scheduler.setBudgets({ pointBudget: 1_000, maxConcurrentDecodes: 4 });
  scheduler.update({ viewProjection: WIDE, cameraPosition: farCam });
  await drain(scheduler);

  // Advance past the window. (1,0,0,0) is parent-protected (its depth-2
  // descendants are still resident). (1,1,0,0), (2,0,0,0), (2,1,0,0) are
  // all evictable this tick. The ordering must be: depth-2 nodes first,
  // then depth-1; within depth-2, furthest from camera first.
  clock = 800;
  scheduler.update({ viewProjection: WIDE, cameraPosition: farCam });
  await drain(scheduler);

  expect(evicted.length).toBeGreaterThanOrEqual(3);
  const depths = evicted.map((n) => n.record.key.depth);
  // Every depth-2 eviction precedes every depth-1 eviction.
  const lastDepth2 = depths.lastIndexOf(2);
  const firstDepth1 = depths.indexOf(1);
  expect(lastDepth2).toBeGreaterThanOrEqual(0);
  expect(firstDepth1).toBeGreaterThanOrEqual(0);
  expect(lastDepth2).toBeLessThan(firstDepth1);

  // Within depth-2, the furthest-from-camera node evicts first.
  const depth2Order = evicted
    .filter((n) => n.record.key.depth === 2)
    .map((n) => n.record.key);
  expect(depth2Order).toHaveLength(2);
  expect(depth2Order[0]).toEqual({ depth: 2, x: 0, y: 0, z: 0 });
  expect(depth2Order[1]).toEqual({ depth: 2, x: 1, y: 0, z: 0 });
});

// --- pressure adaptation ----------------------------------

test('sustained high pressure for ≥ 1 s lowers the target-depth cap by one', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const baseline = streamingBudgets('balanced', false);
  // Budget set to the full source point count — resident/budget ratio sits
  // at 1.0, well above the 0.9 high-pressure threshold.
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    { ...baseline, pointBudget: 3_100 },
    { now: () => clock },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(cloud.residentPointCount).toBe(3_100);

  // Tick 2 — first tick to sample the resident count at 100 % of budget.
  // High-pressure timer arms here; reduction stays 0 (1 s not yet elapsed).
  clock = 100;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  expect(scheduler.stats().pressureDepthReduction).toBe(0);

  // Tick 3 — 0.5 s in, still under the 1 s hold threshold.
  clock = 600;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  expect(scheduler.stats().pressureDepthReduction).toBe(0);

  // Tick 4 — 1.1 s after arming, the threshold trips.
  clock = 1_200;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  expect(scheduler.stats().pressureDepthReduction).toBe(1);
});

test('sustained low pressure for ≥ 2 s restores the depth cap', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const baseline = streamingBudgets('balanced', false);
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    { ...baseline, pointBudget: 3_100 },
    { now: () => clock },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  // Push into high pressure (reduction = 1).
  clock = 100;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  clock = 1_200;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  expect(scheduler.stats().pressureDepthReduction).toBe(1);

  // Enlarge the budget so resident/budget drops to 3100 / 5000 = 0.62,
  // below the 0.7 low-pressure threshold.
  scheduler.setBudgets({ pointBudget: 5_000, maxConcurrentDecodes: 4 });
  clock = 1_300;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  // Low-pressure timer just armed — reduction still active.
  expect(scheduler.stats().pressureDepthReduction).toBe(1);

  // 2.1 s after arming → restore.
  clock = 3_400;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  expect(scheduler.stats().pressureDepthReduction).toBe(0);
});

test('the hysteresis band preserves an active depth reduction without oscillating', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const baseline = streamingBudgets('balanced', false);
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    { ...baseline, pointBudget: 3_100 },
    { now: () => clock },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);

  // Trigger reduction=1.
  clock = 100;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  clock = 1_200;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  expect(scheduler.stats().pressureDepthReduction).toBe(1);

  // Move the budget into the hysteresis band: 3100 / 3900 ≈ 0.795, which
  // sits between the 0.7 and 0.9 thresholds. Neither timer should advance.
  scheduler.setBudgets({ pointBudget: 3_900, maxConcurrentDecodes: 4 });
  clock = 1_300;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  // Hold a long time — no transition either way.
  clock = 10_000;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  expect(scheduler.stats().pressureDepthReduction).toBe(1);
});

// --- v0.3.2 — stable-camera fast path --------------------

test('a stable camera triggers a full rescore once, then reuses the cached wanted set', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    streamingBudgets('balanced', false),
    { now: () => clock },
  );
  // First tick: signature is fresh (no cached value), so a full rescore runs.
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(scheduler.stats().fullRescoreCount).toBe(1);

  // Hold the camera perfectly still through several ticks — every signature
  // input is bit-equal, so the fast path engages and the counter doesn't
  // climb. (The periodic forced rescore is 60 ticks away.)
  for (let i = 0; i < 10; i++) {
    clock += 16;
    scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  }
  expect(scheduler.stats().fullRescoreCount).toBe(1);
});

test('a camera-position change forces a fresh rescore on the next tick', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    streamingBudgets('balanced', false),
    { now: () => clock },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  const baseline = scheduler.stats().fullRescoreCount;

  // A camera move (any axis, any delta) breaks the signature.
  clock += 100;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [1, 0, 0] });
  expect(scheduler.stats().fullRescoreCount).toBe(baseline + 1);

  // Holding still after the move re-engages the fast path.
  clock += 100;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [1, 0, 0] });
  clock += 100;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [1, 0, 0] });
  expect(scheduler.stats().fullRescoreCount).toBe(baseline + 1);
});

test('the periodic forced rescore re-runs after FORCED_RESCORE_INTERVAL_TICKS', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    streamingBudgets('balanced', false),
    { now: () => clock },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  expect(scheduler.stats().fullRescoreCount).toBe(1);

  // 59 more stable ticks — fast path active throughout.
  for (let i = 0; i < 59; i++) {
    clock += 16;
    scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  }
  expect(scheduler.stats().fullRescoreCount).toBe(1);

  // The 60th stable tick crosses the forced-rescore interval — the
  // backstop fires once and the counter increments. Subsequent ticks
  // are fast-path again until the next interval.
  clock += 16;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  expect(scheduler.stats().fullRescoreCount).toBe(2);

  for (let i = 0; i < 5; i++) {
    clock += 16;
    scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  }
  expect(scheduler.stats().fullRescoreCount).toBe(2);
});

test('setBudgets invalidates the cache so the next tick rescores', async () => {
  let clock = 0;
  const cloud = await openCloud();
  const scheduler = new StreamingScheduler(
    cloud,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    streamingBudgets('balanced', false),
    { now: () => clock },
  );
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  await drain(scheduler);
  // Settle into the fast path.
  clock += 16;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  const baseline = scheduler.stats().fullRescoreCount;
  expect(baseline).toBe(1);

  // A budget change breaks the signature even when the camera is identical.
  scheduler.setBudgets({ pointBudget: 1_000, maxConcurrentDecodes: 4 });
  clock += 16;
  scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
  expect(scheduler.stats().fullRescoreCount).toBe(baseline + 1);
});
