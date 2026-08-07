import { StreamingNodeStore } from '../src/render/streaming/StreamingNodeStore';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { StreamingOctree } from '../src/render/streaming/StreamingOctree';
import { CopcSource } from '../src/io/copc/CopcSource';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { isAbortError } from '../src/app/openStreaming';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import type { SynthKey, SynthPage } from './fixtures/copc/synthCopc';
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
    expect([...store.residentNodes()]).toHaveLength(store.counts().resident);
    expect([...store.queuedNodes()]).toHaveLength(store.queuedCount);
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
  expect([...store.iterate()]).toHaveLength(store.size);
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
  // A clean walk with no dropped page is genuinely complete → gradeable "exact".
  expect(cloud.octree.isComplete).toBe(true);
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
  // Every page loaded and parsed → complete.
  expect(cloud.octree.isComplete).toBe(true);
});

// --- StreamingOctree completeness (walk-finished ≠ fully-loaded) -------------
//
// `fullyLoaded` goes true whenever the breadth-first walk STOPS — including when
// it stops short. Each test below drives one way a COPC hierarchy loads short
// and pins that `isComplete` reports it (so the full-cloud grade can refuse to
// call a partial cloud "exact"). The grade reads `octree.nodes()`, which returns
// only the surviving nodes, so nothing downstream would otherwise notice.

/**
 * Wraps a RangeSource and rejects any read at or beyond `failFrom`. The COPC
 * root hierarchy page is read at `rootHierOffset` (below the threshold), so it
 * succeeds; a CHILD page — laid out immediately after the root in the fixture's
 * pages blob — is read at `rootHierOffset + rootHierSize` and fails, modelling a
 * transient range-read failure on a child page during a normal open.
 */
class FailFromRange {
  private readonly inner: ArrayBufferRangeSource;
  private readonly failFrom: number;
  constructor(inner: ArrayBufferRangeSource, failFrom: number) {
    this.inner = inner;
    this.failFrom = failFrom;
  }
  id(): string {
    return this.inner.id();
  }
  kind(): ReturnType<ArrayBufferRangeSource['kind']> {
    return this.inner.kind();
  }
  size(): Promise<number> {
    return this.inner.size();
  }
  readRange(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (offset >= this.failFrom) {
      return Promise.reject(new Error(`range read failed at ${offset}`));
    }
    return this.inner.readRange(offset, length, signal);
  }
}

test('StreamingOctree: a swallowed child-page fetch failure loads short → NOT complete', async () => {
  const fixture = buildSyntheticCopc({
    pages: [
      { pageKey: [0, 0, 0, 0], nodes: [{ key: [0, 0, 0, 0], pointCount: 2000 }], childPages: [1] },
      {
        pageKey: [1, 0, 0, 0],
        nodes: [
          { key: [1, 0, 0, 0], pointCount: 800 },
          { key: [1, 1, 0, 0], pointCount: 600 },
        ],
      },
    ],
  });
  const range = new FailFromRange(
    new ArrayBufferRangeSource(fixture.buffer),
    fixture.rootHierOffset + fixture.rootHierSize, // the child page's offset
  );
  const cloud = await StreamingPointCloud.open(range, 'partial.copc.laz');

  // The walk still reports "finished" and the root survived — the exact trap the
  // grade fell into: nodes() looks healthy.
  expect(cloud.octree.fullyLoaded).toBe(true);
  expect(cloud.octree.nodes().map((n) => n.record.id)).toEqual(['0-0-0-0']);
  // But a page was dropped and recorded, so it is NOT complete.
  expect(cloud.octree.errors.some((e) => /failed to load hierarchy page/.test(e))).toBe(true);
  expect(cloud.octree.isComplete).toBe(false);
});

test('StreamingOctree: a malformed hierarchy entry is skipped → NOT complete', async () => {
  // `bad-hierarchy-entry` corrupts the root page's data entry (dropped as
  // malformed) while the child-page reference stays valid, so the child nodes
  // load but the root node is missing — a real partial parse.
  const fixture = buildSyntheticCopc({
    pages: [
      { pageKey: [0, 0, 0, 0], nodes: [{ key: [0, 0, 0, 0], pointCount: 2000 }], childPages: [1] },
      {
        pageKey: [1, 0, 0, 0],
        nodes: [
          { key: [1, 0, 0, 0], pointCount: 800 },
          { key: [1, 1, 0, 0], pointCount: 600 },
        ],
      },
    ],
    corrupt: 'bad-hierarchy-entry',
  });
  const cloud = await StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'corrupt.copc.laz',
  );
  expect(cloud.octree.fullyLoaded).toBe(true);
  expect(cloud.octree.errors.length).toBeGreaterThan(0);
  expect(cloud.octree.isComplete).toBe(false);
});

test('StreamingOctree: hitting the hierarchy-page ceiling loads short → NOT complete', async () => {
  // A fan-out wide enough to trip the MAX_HIERARCHY_PAGES ceiling: the root
  // references more child pages than the cap allows, so the walk stops with a
  // ceiling error and never loads the tail. Pins that the documented 4096-page
  // cap makes the octree incomplete rather than silently truncating "exact".
  // Comfortably above the documented MAX_HIERARCHY_PAGES (4096) so the walk trips
  // the cap regardless of the exact off-by-one at the boundary.
  const FANOUT = 4200;
  const childPages: number[] = [];
  const pages: SynthPage[] = [{ pageKey: [0, 0, 0, 0], nodes: [], childPages }];
  for (let i = 1; i <= FANOUT; i++) {
    // Spread children across depth-1 octants deterministically; the exact keys
    // don't matter, only that there are more PAGES (distinct offsets) than the
    // ceiling admits.
    const key: SynthKey = [1, i % 2, (i >> 1) % 2, (i >> 2) % 2];
    pages.push({ pageKey: key, nodes: [{ key, pointCount: 10 }], childPages: [] });
    childPages.push(i);
  }
  const fixture = buildSyntheticCopc({ pages });
  const cloud = await StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'ceiling.copc.laz',
  );
  expect(cloud.octree.fullyLoaded).toBe(true);
  expect(cloud.octree.errors.some((e) => /exceeded .* pages/.test(e))).toBe(true);
  expect(cloud.octree.isComplete).toBe(false);
});

// --- StreamingOctree cancel vs. timeout on the hierarchy walk ----------------
//
// The mid-walk `signal.aborted` guard must keep the three outcomes distinct: a
// user cancel is a SILENT cancellation, a timeout stays a VISIBLE error. The
// guard used to throw a plain `Error('Hierarchy load aborted')`, which the
// cancel classifier read as neither — so a user cancel surfaced as an ordinary
// load error. It now propagates the signal's own abort reason.

function twoPageFixture(): ReturnType<typeof buildSyntheticCopc> {
  return buildSyntheticCopc({
    pages: [
      { pageKey: [0, 0, 0, 0], nodes: [{ key: [0, 0, 0, 0], pointCount: 2000 }], childPages: [1] },
      { pageKey: [1, 0, 0, 0], nodes: [{ key: [1, 0, 0, 0], pointCount: 800 }] },
    ],
  });
}

test('StreamingOctree: a user cancel throws an AbortError the classifier treats as silent', async () => {
  const fixture = twoPageFixture();
  const source = await CopcSource.open(new ArrayBufferRangeSource(fixture.buffer));
  const octree = new StreamingOctree(source);
  const controller = new AbortController();
  controller.abort(); // the user pressed Cancel
  const err = await octree.loadFullHierarchy(controller.signal).catch((e: unknown) => e);
  expect((err as Error).name).toBe('AbortError');
  expect(isAbortError(err)).toBe(true);
});

test('StreamingOctree: a timeout-reason abort stays a visible error, not a silent cancel', async () => {
  const fixture = twoPageFixture();
  const source = await CopcSource.open(new ArrayBufferRangeSource(fixture.buffer));
  const octree = new StreamingOctree(source);
  const controller = new AbortController();
  const timeout = new DOMException('Hierarchy load timed out', 'TimeoutError');
  controller.abort(timeout);
  const err = await octree.loadFullHierarchy(controller.signal).catch((e: unknown) => e);
  // The signal's own timeout reason propagates, so it is distinguishable from a
  // cancel and the classifier refuses to swallow it.
  expect(err).toBe(timeout);
  expect(isAbortError(err)).toBe(false);
});
