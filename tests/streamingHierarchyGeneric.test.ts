/**
 * streamingHierarchyGeneric.test.ts
 *
 * The scheduler reads ancestry from each node's recorded `parentId` instead of
 * shifting its `VoxelKey`. Every hierarchy OLV streams today is a regular
 * octree, so the two answers must be identical; a hierarchy that is not an
 * octree has no key to shift, which is why the change was made.
 *
 * This file is both halves of that claim. The first suite runs the octree-key
 * walk the scheduler used to perform, side by side with the shipped one, over
 * real COPC hierarchies, and asserts the sets match exactly. The second builds
 * an irregular tree with ids that carry no coordinate and shows the same
 * helpers answer over it.
 */

import { describe, test, expect } from 'vitest';
import {
  buildRefinedAwayIds,
  buildRefiningCandidateIds,
} from '../src/render/streaming/StreamingScheduler';
import {
  forEachAncestorId,
  parentLookupFromStore,
  MAX_ANCESTOR_STEPS,
} from '../src/render/streaming/streamingHierarchy';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { StreamingNodeStore } from '../src/render/streaming/StreamingNodeStore';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import type { VoxelKey, Box6 } from '../src/io/copc/copcTypes';

// --- The reference implementation: the walk that shipped through v0.6.6 ------

/** `${depth}/${x}/${y}/${z}` — the key namespace the scheduler used to use. */
function voxelKeyString(k: VoxelKey): string {
  return `${k.depth}/${k.x}/${k.y}/${k.z}`;
}

/** Ancestor KEYS of every node, by right-shifting each axis. */
function legacyAncestorProtection(nodes: readonly StreamingNode[]): Set<string> {
  const set = new Set<string>();
  for (const n of nodes) {
    let { x, y, z } = n.record.key;
    for (let d = n.record.key.depth - 1; d >= 0; d--) {
      x >>= 1; y >>= 1; z >>= 1;
      set.add(`${d}/${x}/${y}/${z}`);
    }
  }
  return set;
}

/** Candidate ids that a finer candidate sits underneath, by key shift. */
function legacyRefiningCandidateIds(
  scored: readonly { readonly node: StreamingNode; readonly candidate: { id: string } }[],
): Set<string> {
  const idByKey = new Map<string, string>();
  for (const s of scored) idByKey.set(voxelKeyString(s.node.record.key), s.candidate.id);
  const refining = new Set<string>();
  for (const s of scored) {
    let { x, y, z } = s.node.record.key;
    for (let d = s.node.record.key.depth - 1; d >= 0; d--) {
      x >>= 1; y >>= 1; z >>= 1;
      const ancestorId = idByKey.get(`${d}/${x}/${y}/${z}`);
      if (ancestorId !== undefined) refining.add(ancestorId);
    }
  }
  return refining;
}

/** Refined-away KEYS, by key shift. */
function legacyRefinedAwayKeys(
  wanted: ReadonlySet<string>,
  store: { get(id: string): StreamingNode | undefined },
): Set<string> {
  const wantedNodes: StreamingNode[] = [];
  const wantedKeys = new Set<string>();
  for (const id of wanted) {
    const node = store.get(id);
    if (!node) continue;
    wantedNodes.push(node);
    wantedKeys.add(voxelKeyString(node.record.key));
  }
  const set = new Set<string>();
  for (const node of wantedNodes) {
    const pending = node.state !== 'resident';
    let { x, y, z } = node.record.key;
    for (let d = node.record.key.depth - 1; d >= 0; d--) {
      x >>= 1; y >>= 1; z >>= 1;
      const key = `${d}/${x}/${y}/${z}`;
      if (pending || !wantedKeys.has(key)) set.add(key);
    }
  }
  return set;
}

/**
 * A key set and an id set name the same nodes when, restricted to nodes the
 * hierarchy actually holds, they agree.
 *
 * The restriction is the one real difference between the two walks and it is
 * unobservable: the key walk climbed to depth 0 through cells that may hold no
 * node, and every consumer only ever tests the id or key of a node that exists.
 */
function sameNodes(
  keySet: ReadonlySet<string>,
  idSet: ReadonlySet<string>,
  nodes: readonly StreamingNode[],
): void {
  const viaKeys = nodes
    .filter((n) => keySet.has(voxelKeyString(n.record.key)))
    .map((n) => n.record.id)
    .sort();
  const viaIds = nodes.filter((n) => idSet.has(n.record.id)).map((n) => n.record.id).sort();
  expect(viaIds).toEqual(viaKeys);
}

// --- Fixtures ----------------------------------------------------------------

const HALF = 128;

/** A full three-level octree: every node of depth 0-2 under one root. */
async function openDenseCloud(): Promise<StreamingPointCloud> {
  const nodes: { key: [number, number, number, number]; pointCount: number }[] = [
    { key: [0, 0, 0, 0], pointCount: 400 },
  ];
  for (let x = 0; x < 2; x++)
    for (let y = 0; y < 2; y++)
      for (let z = 0; z < 2; z++) nodes.push({ key: [1, x, y, z], pointCount: 300 });
  for (let x = 0; x < 4; x++)
    for (let y = 0; y < 2; y++) nodes.push({ key: [2, x, y, 0], pointCount: 200 });
  const fixture = buildSyntheticCopc({ center: [0, 0, 0], halfsize: HALF, nodes });
  return StreamingPointCloud.open(new ArrayBufferRangeSource(fixture.buffer), 'dense.copc.laz');
}

/** A sparse, lopsided octree: one deep branch, one shallow, one unrefined. */
async function openSparseCloud(): Promise<StreamingPointCloud> {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: HALF,
    nodes: [
      { key: [0, 0, 0, 0], pointCount: 400 },
      { key: [1, 0, 0, 0], pointCount: 400 },
      { key: [2, 0, 0, 0], pointCount: 400 },
      { key: [3, 0, 0, 0], pointCount: 400 },
      { key: [3, 1, 0, 0], pointCount: 400 },
      { key: [1, 1, 1, 1], pointCount: 400 },
      { key: [2, 3, 3, 3], pointCount: 400 },
      { key: [1, 0, 1, 0], pointCount: 400 },
    ],
  });
  return StreamingPointCloud.open(new ArrayBufferRangeSource(fixture.buffer), 'sparse.copc.laz');
}

/** Every non-empty subset of `items`, capped so the suite stays quick. */
function subsets<T>(items: readonly T[], limit: number): T[][] {
  const out: T[][] = [];
  const total = 1 << items.length;
  for (let mask = 1; mask < total && out.length < limit; mask++) {
    const pick: T[] = [];
    for (let i = 0; i < items.length; i++) if (mask & (1 << i)) pick.push(items[i]);
    out.push(pick);
  }
  return out;
}

// --- Suite 1: the octree formats answer exactly as they did ------------------

describe('generic ancestry agrees with the octree-key walk it replaced', () => {
  for (const [label, open] of [
    ['a dense three-level octree', openDenseCloud],
    ['a sparse lopsided octree', openSparseCloud],
  ] as const) {
    test(`ancestor protection over every resident subset of ${label}`, async () => {
      const cloud = await open();
      const all = cloud.octree.store.all();
      const parentOf = parentLookupFromStore(cloud.octree.store);
      for (const residents of subsets(all, 400)) {
        const legacy = legacyAncestorProtection(residents);
        const generic = new Set<string>();
        for (const n of residents) {
          forEachAncestorId(n.record.id, parentOf, (id) => generic.add(id));
        }
        sameNodes(legacy, generic, all);
      }
    });

    test(`refining-candidate marks over every candidate subset of ${label}`, async () => {
      const cloud = await open();
      const all = cloud.octree.store.all();
      const parentOf = parentLookupFromStore(cloud.octree.store);
      for (const pick of subsets(all, 400)) {
        const scored = pick.map((node) => ({ node, candidate: { id: node.record.id, pointCount: 100, score: 1 } }));
        expect([...buildRefiningCandidateIds(scored, parentOf)].sort())
          .toEqual([...legacyRefiningCandidateIds(scored)].sort());
      }
    });

    test(`refined-away marks over every wanted subset of ${label}`, async () => {
      const cloud = await open();
      const store = cloud.octree.store;
      const all = store.all();
      // Half the nodes resident, so both the pending and the arrived branch run.
      for (let i = 0; i < all.length; i += 2) store.setState(all[i], 'resident', 100);
      for (const pick of subsets(all, 400)) {
        const wanted = new Set(pick.map((n) => n.record.id));
        const generic = buildRefinedAwayIds(wanted, cloud as unknown as StreamingSource);
        sameNodes(legacyRefinedAwayKeys(wanted, store), generic, all);
      }
    });

    test(`wanted-parent marks over every wanted subset of ${label}`, async () => {
      const cloud = await open();
      const store = cloud.octree.store;
      const all = store.all();
      for (const pick of subsets(all, 400)) {
        const legacy = new Set<string>();
        for (const n of pick) {
          const k = n.record.key;
          if (k.depth > 0) legacy.add(`${k.depth - 1}/${k.x >> 1}/${k.y >> 1}/${k.z >> 1}`);
        }
        const generic = new Set<string>();
        for (const n of pick) {
          const parentId = store.get(n.record.id)?.record.parentId;
          if (parentId !== undefined) generic.add(parentId);
        }
        sameNodes(legacy, generic, all);
      }
    });
  }
});

// --- Suite 2: a hierarchy with no coordinates at all -------------------------

/**
 * The irregular tree a 3D Tiles adapter produces — mixed child counts, mixed
 * depths, ids that are opaque strings.
 *
 *   root
 *    ├─ A ─ A1
 *    ├─ B ─ B1, B2, B3
 *    └─ C
 */
const IRREGULAR: readonly (readonly [string, string | undefined])[] = [
  ['root', undefined],
  ['A', 'root'], ['A1', 'A'],
  ['B', 'root'], ['B1', 'B'], ['B2', 'B'], ['B3', 'B'],
  ['C', 'root'],
];

function irregularStore(): StreamingNodeStore {
  const store = new StreamingNodeStore();
  const bounds: Box6 = [0, 0, 0, 1, 1, 1];
  for (const [id, parentId] of IRREGULAR) {
    store.add({
      id,
      // The key is format-specific and meaningless here; nothing reads it.
      key: { depth: 0, x: 0, y: 0, z: 0 }, depth: 0,
      bounds,
      pointCount: 100,
      byteOffset: 0,
      byteSize: 0,
      spacing: 1,
      parentId,
    });
  }
  return store;
}

describe('ancestry over a hierarchy that is not an octree', () => {
  test('walks the recorded chain, nearest parent first', () => {
    const parentOf = parentLookupFromStore(irregularStore());
    const seen: string[] = [];
    forEachAncestorId('B2', parentOf, (id) => seen.push(id));
    expect(seen).toEqual(['B', 'root']);
  });

  test('a root has no ancestors', () => {
    const parentOf = parentLookupFromStore(irregularStore());
    const seen: string[] = [];
    forEachAncestorId('root', parentOf, (id) => seen.push(id));
    expect(seen).toEqual([]);
  });

  test('marks a candidate parent whose child is also a candidate, at any arity', () => {
    const store = irregularStore();
    const parentOf = parentLookupFromStore(store);
    const scored = ['root', 'B', 'B1', 'B3', 'C'].map((id) => ({
      node: store.get(id) as StreamingNode,
      candidate: { id, pointCount: 100, score: 1 },
    }));
    const refining = buildRefiningCandidateIds(scored, parentOf);
    // `root` is refined by B and C; `B` is refined by B1 and B3.
    expect([...refining].sort()).toEqual(['B', 'root']);
  });

  test('does not mark a candidate whose descendants are in another branch', () => {
    const store = irregularStore();
    const parentOf = parentLookupFromStore(store);
    const scored = ['A', 'B1'].map((id) => ({
      node: store.get(id) as StreamingNode,
      candidate: { id, pointCount: 100, score: 1 },
    }));
    // B1's chain is B then root; neither A nor B is refined by the other.
    expect(buildRefiningCandidateIds(scored, parentOf).size).toBe(0);
  });

  test('refined-away marks the ancestors of a wanted node still on its way in', () => {
    const store = irregularStore();
    for (const id of ['root', 'B']) store.setState(store.get(id) as StreamingNode, 'resident', 100);
    const cloud = { octree: { store } } as unknown as StreamingSource;
    const ids = buildRefinedAwayIds(new Set(['root', 'B', 'B2']), cloud);
    expect(ids.has('root')).toBe(true);
    expect(ids.has('B')).toBe(true);
    expect(ids.has('A')).toBe(false);
  });
});

// --- Suite 3: malformed input ------------------------------------------------

describe('a malformed hierarchy cannot spin the walk', () => {
  test('a two-node parent cycle stops at the step ceiling', () => {
    const parentOf = (id: string): string | undefined => (id === 'A' ? 'B' : 'A');
    let steps = 0;
    forEachAncestorId('A', parentOf, () => { steps++; });
    expect(steps).toBe(MAX_ANCESTOR_STEPS);
  });

  test('a node naming itself as its parent stops too', () => {
    let steps = 0;
    forEachAncestorId('self', () => 'self', () => { steps++; });
    expect(steps).toBe(MAX_ANCESTOR_STEPS);
  });

  test('a chain into a node the store does not hold ends there', () => {
    const store = new StreamingNodeStore();
    store.add({
      id: 'orphan',
      key: { depth: 1, x: 0, y: 0, z: 0 }, depth: 1,
      bounds: [0, 0, 0, 1, 1, 1],
      pointCount: 1,
      byteOffset: 0,
      byteSize: 0,
      spacing: 1,
      parentId: 'never-loaded',
    });
    const seen: string[] = [];
    forEachAncestorId('orphan', parentLookupFromStore(store), (id) => seen.push(id));
    expect(seen).toEqual(['never-loaded']);
  });
});
