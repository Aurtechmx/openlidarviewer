/**
 * streamingEvictionHysteresis.test.ts — the eviction-side anti-flicker fix at
 * the scheduler seam.
 *
 * `evictionPolicy.test.ts` pins the decision logic. These drive the real
 * scheduler over a synthetic COPC, because a pure policy is only as good as the
 * facts it is handed: an ancestor walk that quietly marked nothing, or a
 * residency clock that was never stamped, would leave the whole thing inert
 * while every unit test still passed.
 *
 * The load-bearing test here is the last one. An earlier admission-side attempt
 * at this flicker froze the level of detail — the protection it gave resident
 * nodes became a veto and nothing ever yielded. This asserts refinement still
 * reaches full depth while eviction pressure runs continuously.
 */

import { describe, test, expect } from 'vitest';
import {
  StreamingScheduler,
  buildRefinedAwayKeys,
} from '../src/render/streaming/StreamingScheduler';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';
import { DEFAULT_EVICTION_HYSTERESIS } from '../src/render/streaming/evictionPolicy';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
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

/** Wait until the scheduler has no queued or in-flight work. */
async function drain(scheduler: StreamingScheduler): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const s = scheduler.stats();
    if (s.queued === 0 && s.loading === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * A cube split into two halves along X, each half refined two levels deep.
 * Region A is the low-X half (`[1,0,0,0]` and its children), region B the
 * high-X half. A window frustum over one half leaves the other half's nodes
 * out of frustum while the root, which spans both, stays visible — the exact
 * state a camera move produces on a real scan.
 */
const HALF = 128;
async function openTwoRegionCloud(): Promise<StreamingPointCloud> {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: HALF,
    nodes: [
      { key: [0, 0, 0, 0], pointCount: 400 },
      // Region A — low X.
      { key: [1, 0, 0, 0], pointCount: 400 },
      { key: [2, 0, 0, 0], pointCount: 400 },
      { key: [2, 1, 0, 0], pointCount: 400 },
      // Region B — high X.
      { key: [1, 1, 0, 0], pointCount: 400 },
      { key: [2, 2, 0, 0], pointCount: 400 },
      { key: [2, 3, 0, 0], pointCount: 400 },
    ],
  });
  return StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'evict.copc.laz',
  );
}

/**
 * A column-major orthographic view-projection framing an axis-aligned window of
 * half-extent `half` centred at `target`. A node is inside exactly when its
 * bounds overlap the window on every axis, so a narrow window over one half of
 * the cube culls the other half.
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
  m[12] = -target[0] * s;
  m[13] = -target[1] * s;
  m[14] = -target[2] * s;
  return m;
}

/**
 * The two half-cube centres, and a window just tight enough to hold one half.
 * The synthetic octree puts the `y = z = 0` octants in the low corner, so a
 * region centre is negative on Y and Z as well as offset on X. At this width
 * VIEW_A sees exactly the root plus region A, and VIEW_B exactly the root plus
 * region B, with nothing shared but the root.
 */
const CAM_A: [number, number, number] = [-HALF / 2, -HALF / 2, -HALF / 2];
const CAM_B: [number, number, number] = [HALF / 2, -HALF / 2, -HALF / 2];
const VIEW_A = windowViewProjection(CAM_A, HALF * 0.47);
const VIEW_B = windowViewProjection(CAM_B, HALF * 0.47);

// --- The seam: does the scheduler actually compute the refined-away flag? ----

describe('buildRefinedAwayKeys marks the nodes finer detail is arriving under', () => {
  test('marks every ancestor of a wanted node that has not arrived yet', async () => {
    const cloud = await openTwoRegionCloud();
    const store = cloud.octree.store;
    // A depth-2 node in region A is wanted and still unloaded: both its
    // ancestors are holding budget it is queued against.
    const wanted = new Set(['0-0-0-0', '1-0-0-0', '2-0-0-0']);
    for (const id of ['0-0-0-0', '1-0-0-0']) {
      const node = store.get(id);
      expect(node).toBeDefined();
      store.setState(node as StreamingNode, 'resident', 400);
    }
    const keys = buildRefinedAwayKeys(wanted, cloud);
    expect(keys.has('0/0/0/0')).toBe(true);
    expect(keys.has('1/0/0/0')).toBe(true);
    // Region B is untouched — nothing is arriving under it.
    expect(keys.has('1/1/0/0')).toBe(false);
  });

  test('marks nothing once every wanted node has arrived', async () => {
    const cloud = await openTwoRegionCloud();
    const store = cloud.octree.store;
    const wanted = new Set(['0-0-0-0', '1-0-0-0', '2-0-0-0']);
    for (const id of wanted) {
      const node = store.get(id);
      store.setState(node as StreamingNode, 'resident', 400);
    }
    // Fully refined and fully resident: no node is being replaced, so the
    // exemption must not fire and hysteresis holds normally.
    expect(buildRefinedAwayKeys(wanted, cloud).size).toBe(0);
  });

  test('marks an ancestor the selector dropped while a finer node stayed', async () => {
    const cloud = await openTwoRegionCloud();
    const store = cloud.octree.store;
    // The depth-1 node has left the wanted set; its child has not. That is the
    // literal refined-away case, and it holds even though the child is already
    // resident and nothing is pending.
    const wanted = new Set(['0-0-0-0', '2-0-0-0']);
    for (const id of ['0-0-0-0', '1-0-0-0', '2-0-0-0']) {
      store.setState(store.get(id) as StreamingNode, 'resident', 400);
    }
    const keys = buildRefinedAwayKeys(wanted, cloud);
    expect(keys.has('1/0/0/0')).toBe(true);
    // The root is still wanted and its wanted descendant has arrived, so it is
    // not being replaced by anything.
    expect(keys.has('0/0/0/0')).toBe(false);
  });
});

// --- Preference order, driven through the real scheduler --------------------

describe('pressure sheds the region behind the camera, not the coverage in front', () => {
  test('keeps the visible root resident and drops the out-of-frustum region', async () => {
    let clock = 0;
    const cloud = await openTwoRegionCloud();
    const evicted: StreamingNode[] = [];
    const scheduler = new StreamingScheduler(
      cloud,
      fakeDecoder,
      { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n) },
      { ...streamingBudgets('balanced', false), pointBudget: 1_600 },
      { now: () => clock, evictDeferMs: 10_000 },
    );

    // Look at region A until it is fully resident: root + three A nodes.
    scheduler.update({ viewProjection: VIEW_A, cameraPosition: CAM_A });
    await drain(scheduler);
    expect(cloud.residentPointCount).toBe(1_600);

    // Swing to region B on a tighter budget. Region A is now out of frustum,
    // the root is still visible and wanted, and region B's depth-1 node is
    // wanted but has not arrived — so the root is superseded. Resident (1 600)
    // is past 1.5 × 800, so the plan runs.
    clock += 16;
    scheduler.setBudgets({ pointBudget: 800, maxConcurrentDecodes: 1 });
    scheduler.update({ viewProjection: VIEW_B, cameraPosition: CAM_B });

    const evictedIds = evicted.map((n) => n.record.id);
    // The coarse coverage the user is looking at survived, even though finer
    // detail is arriving under it.
    expect(evictedIds).not.toContain('0-0-0-0');
    // What went is the region behind the camera, deepest first.
    expect(evictedIds).toContain('2-1-0-0');
    expect(evictedIds).toContain('2-0-0-0');
    // And it stopped inside the hysteresis band instead of cutting to the
    // budget itself, so the next selection does not immediately ask it back.
    expect(cloud.residentPointCount).toBeLessThanOrEqual(
      800 * DEFAULT_EVICTION_HYSTERESIS.releaseRatio,
    );
    expect(cloud.residentPointCount).toBeGreaterThan(0);
  });

  test('a marginal overshoot evicts nothing at all', async () => {
    let clock = 0;
    const cloud = await openTwoRegionCloud();
    const evicted: StreamingNode[] = [];
    const scheduler = new StreamingScheduler(
      cloud,
      fakeDecoder,
      { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n) },
      { ...streamingBudgets('balanced', false), pointBudget: 1_600 },
      // A defer window longer than the run isolates the pressure path.
      { now: () => clock, evictDeferMs: 1_000_000 },
    );
    scheduler.update({ viewProjection: VIEW_A, cameraPosition: CAM_A });
    await drain(scheduler);
    expect(cloud.residentPointCount).toBe(1_600);

    // 1 600 resident against a 1 200 budget is a third over — real, but inside
    // the margin. Before the fix this was already below the trigger; what has
    // changed is that crossing it no longer cuts to the budget.
    clock += 16;
    scheduler.setBudgets({ pointBudget: 1_200, maxConcurrentDecodes: 4 });
    scheduler.update({ viewProjection: VIEW_A, cameraPosition: CAM_A });
    await drain(scheduler);
    expect(evicted).toHaveLength(0);
  });
});

// --- Boundary noise ---------------------------------------------------------

describe('budget-boundary noise does not churn the resident set', () => {
  test('a resident visible node is not evicted and re-admitted across ticks', async () => {
    let clock = 0;
    const cloud = await openTwoRegionCloud();
    const evicted: string[] = [];
    const admitted: string[] = [];
    const scheduler = new StreamingScheduler(
      cloud,
      fakeDecoder,
      {
        onNodeReady: (n) => admitted.push(n.record.id),
        onNodeEvicted: (n) => evicted.push(n.record.id),
      },
      { ...streamingBudgets('balanced', false), pointBudget: 1_600 },
      { now: () => clock, evictDeferMs: 2_000 },
    );
    scheduler.update({ viewProjection: VIEW_A, cameraPosition: CAM_A });
    await drain(scheduler);
    const admittedOnce = admitted.length;
    expect(cloud.residentPointCount).toBe(1_600);

    // Now wobble the budget a few percent either side of the resident total for
    // a few hundred ticks — the score-noise flicker, reproduced through the
    // budget rather than the camera so it is deterministic. Nothing should be
    // dropped and re-decoded.
    for (let tick = 0; tick < 300; tick++) {
      clock += 16;
      const wobble = 1 + ((tick % 7) - 3) * 0.01;
      scheduler.setBudgets({
        pointBudget: Math.round(1_600 * wobble),
        maxConcurrentDecodes: 4,
      });
      scheduler.update({ viewProjection: VIEW_A, cameraPosition: CAM_A });
      await drain(scheduler);
    }
    expect(evicted).toEqual([]);
    expect(admitted).toHaveLength(admittedOnce);
  });
});

// --- The LOD-freeze regression guard ----------------------------------------

describe('eviction hysteresis never freezes the level of detail', () => {
  test('refinement still reaches full depth while pressure runs continuously', async () => {
    let clock = 0;
    const budget = 1_200;
    const cloud = await openTwoRegionCloud();
    let evictions = 0;
    // Depths admitted AFTER eviction first fired. This is the assertion that
    // matters: once hysteresis is live, is the scheduler still refining, or has
    // retention taken the budget and stopped the scene where it stands?
    const depthsAdmittedUnderPressure = new Set<number>();
    const scheduler = new StreamingScheduler(
      cloud,
      fakeDecoder,
      {
        onNodeReady: (n) => {
          if (evictions > 0) depthsAdmittedUnderPressure.add(n.record.key.depth);
        },
        onNodeEvicted: () => {
          evictions += 1;
        },
      },
      // One decode at a time, so there is always a wanted node waiting behind
      // the budget — the state in which a retention rule can starve refinement.
      { ...streamingBudgets('balanced', false), pointBudget: budget, maxConcurrentDecodes: 1 },
      // A short defer window so the run holds each half long enough for the
      // region behind the camera to lapse. The production window is 2 s and a
      // test that waited it out 12 times would spend a minute doing nothing.
      { now: () => clock, evictDeferMs: 300 },
    );

    let peakResident = 0;
    const everResident = new Set<string>();
    // Sweep between the two halves for a long run. Each swing un-wants a whole
    // region and wants a fresh one, so eviction and admission are both live the
    // entire time.
    for (let sweep = 0; sweep < 12; sweep++) {
      const toB = sweep % 2 === 0;
      for (let tick = 0; tick < 40; tick++) {
        clock += 16;
        scheduler.update({
          viewProjection: toB ? VIEW_B : VIEW_A,
          cameraPosition: toB ? CAM_B : CAM_A,
        });
        await new Promise((r) => setTimeout(r, 0));
        peakResident = Math.max(peakResident, cloud.residentPointCount);
        for (const node of cloud.octree.store.residentNodes()) {
          everResident.add(node.record.id);
        }
      }
    }

    // Eviction ran, so hysteresis was under load rather than idle.
    expect(evictions).toBeGreaterThan(0);
    // And refinement kept reaching the deepest level in the hierarchy while it
    // did. A frozen LOD shows up here as a set that holds only depth 0 and 1.
    expect(depthsAdmittedUnderPressure.has(2)).toBe(true);
    // Both halves were refined to depth 2 at some point in the run.
    expect([...everResident]).toEqual(
      expect.arrayContaining(['2-0-0-0', '2-2-0-0']),
    );

    // And the resident set stayed bounded the whole way: hysteresis raised the
    // floor eviction releases to, it did not remove the ceiling.
    expect(peakResident).toBeLessThanOrEqual(
      budget * DEFAULT_EVICTION_HYSTERESIS.triggerRatio + 400,
    );
  }, 30_000);

  test('the dwell rule yields rather than leave the budget blown', async () => {
    let clock = 0;
    const cloud = await openTwoRegionCloud();
    const evicted: string[] = [];
    const scheduler = new StreamingScheduler(
      cloud,
      fakeDecoder,
      { onNodeReady: () => {}, onNodeEvicted: (n) => evicted.push(n.record.id) },
      { ...streamingBudgets('balanced', false), pointBudget: 1_600 },
      // The defer window is long enough that the lapsed path can never fire in
      // this test: whatever is evicted here came from the pressure plan.
      { now: () => clock, evictDeferMs: 1_000_000 },
    );
    scheduler.update({ viewProjection: VIEW_A, cameraPosition: CAM_A });
    await drain(scheduler);
    expect(cloud.counts().resident).toBe(4);

    // Every resident node arrived one tick ago and every one of them is still
    // on screen, so the whole set is dwell-protected. Squeeze the budget hard
    // without moving the camera: the plan must still release points rather
    // than protect everything and leave the budget blown.
    clock += 16;
    scheduler.setBudgets({ pointBudget: 700, maxConcurrentDecodes: 1 });
    scheduler.update({ viewProjection: VIEW_A, cameraPosition: CAM_A });

    expect(evicted.length).toBeGreaterThan(0);
    expect(cloud.residentPointCount).toBeLessThanOrEqual(
      700 * DEFAULT_EVICTION_HYSTERESIS.releaseRatio,
    );
    // The dwell window has not elapsed for anything, so this could only have
    // happened because hysteresis is a preference and not a veto.
    expect(clock - 16).toBeLessThan(DEFAULT_EVICTION_HYSTERESIS.minVisibleDwellMs);
  });
});
