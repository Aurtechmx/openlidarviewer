/**
 * oocIndexer.test.ts — the out-of-core octree build's correctness floor.
 *
 * The indexer reads a point source twice: once for the bounds and count that fix
 * the grid, once to bucket every point into its leaf's spill file. The three
 * properties the roadmap's phase-1 gate names are pinned here on a synthetic
 * cloud far larger than the memory budget it is given:
 *
 *   1. no point is lost or duplicated — the leaf counts sum to the source count;
 *   2. every point lands inside the cube of the leaf it was written to;
 *   3. peak buffered memory stays within the budget, not the cloud size.
 *
 * A memory spill store stands in for OPFS, so the whole build runs in Node.
 */
import { describe, it, expect } from 'vitest';
import { indexOutOfCore, type PointSource, type SpillStore } from '../src/io/heavy/oocIndexer';

/** An in-memory {@link SpillStore}: append concatenates, read joins. */
function memoryStore(): SpillStore & { totalBytes(): number } {
  const parts = new Map<string, Uint8Array[]>();
  return {
    async append(key, bytes) {
      const arr = parts.get(key) ?? [];
      arr.push(bytes.slice());
      parts.set(key, arr);
    },
    async read(key) {
      const arr = parts.get(key) ?? [];
      const total = arr.reduce((n, b) => n + b.byteLength, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const b of arr) {
        out.set(b, o);
        o += b.byteLength;
      }
      return out;
    },
    async keys() {
      return [...parts.keys()];
    },
    totalBytes() {
      let n = 0;
      for (const arr of parts.values()) for (const b of arr) n += b.byteLength;
      return n;
    },
  };
}

/** A deterministic cloud yielded in fixed-size batches, re-iterable for two passes. */
function syntheticSource(count: number, batchPoints: number): PointSource {
  return {
    async *batches() {
      let s = 987654321 >>> 0;
      const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
      let emitted = 0;
      while (emitted < count) {
        const n = Math.min(batchPoints, count - emitted);
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          positions[i * 3] = 500000 + rnd() * 1000;
          positions[i * 3 + 1] = 4100000 + rnd() * 600;
          positions[i * 3 + 2] = 190 + rnd() * 70;
        }
        emitted += n;
        yield { positions, count: n };
      }
    },
  };
}

const RECORD_BYTES = 12; // three float32 per point

describe('out-of-core octree indexer', () => {
  it('conserves points, keeps each inside its leaf cube, and bounds memory', async () => {
    const count = 500_000;
    const batchPoints = 20_000;
    const budget = 256 * 1024; // far below the ~6 MB cloud
    const store = memoryStore();

    const index = await indexOutOfCore(syntheticSource(count, batchPoints), store, {
      pointsPerLeaf: 25_000,
      memoryBudgetBytes: budget,
    });

    // The grid actually split (this cloud needs more than one leaf).
    expect(index.depth).toBeGreaterThan(0);
    expect(index.leaves.length).toBeGreaterThan(1);

    // 1. Conservation: every point is accounted for exactly once.
    expect(index.pointCount).toBe(count);
    const summed = index.leaves.reduce((n, l) => n + l.pointCount, 0);
    expect(summed).toBe(count);
    // What the store holds matches what the index reports.
    expect(store.totalBytes()).toBe(count * RECORD_BYTES);
    expect((await store.keys()).sort()).toEqual(index.leaves.map((l) => l.key).sort());

    // 2. Containment: read each leaf back and check every point is in its cube.
    // Violations are counted, not asserted per point, so the check does not make
    // a million expect() calls.
    let checked = 0;
    let violations = 0;
    for (const leaf of index.leaves) {
      const cube = index.grid.cubeFor(leaf.key);
      const bytes = await store.read(leaf.key);
      expect(bytes.byteLength).toBe(leaf.pointCount * RECORD_BYTES);
      const xyz = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      for (let i = 0; i < leaf.pointCount; i++) {
        for (let a = 0; a < 3; a++) {
          const v = xyz[i * 3 + a];
          if (v < cube.min[a] || v > cube.min[a] + cube.size) violations++;
        }
      }
      checked += leaf.pointCount;
    }
    expect(violations).toBe(0);
    expect(checked).toBe(count);

    // 3. Bounded memory: peak buffered bytes never blew past the budget.
    expect(index.peakBufferedBytes).toBeLessThanOrEqual(budget + RECORD_BYTES);
  });

  it('collapses to a single root leaf when the cloud fits one node', async () => {
    const store = memoryStore();
    const index = await indexOutOfCore(syntheticSource(1000, 500), store, { pointsPerLeaf: 100_000 });
    expect(index.depth).toBe(0);
    expect(index.leaves).toHaveLength(1);
    expect(index.leaves[0].key).toBe('');
    expect(index.leaves[0].pointCount).toBe(1000);
  });
});

/**
 * The PYRAMID. A point settles at the coarsest cell with room, not straight at
 * its leaf, so the store holds nodes at several depths.
 *
 * This is what makes the store streamable at all. With every point at maximum
 * depth there is no coarse representation, so drawing the whole scan would mean
 * loading the whole scan — the memory wall the out-of-core path exists to
 * remove, and the reason Phase 3's residency gate could never be met.
 */
describe('out-of-core indexer — the LOD pyramid', () => {
  const build = async (count: number, pointsPerLeaf: number) => {
    const store = memoryStore();
    const index = await indexOutOfCore(syntheticSource(count, 20_000), store, {
      pointsPerLeaf,
      memoryBudgetBytes: 256 * 1024,
    });
    return { store, index };
  };

  it('emits nodes at MORE THAN ONE depth (a pyramid, not a flat leaf set)', async () => {
    const { index } = await build(200_000, 10_000);
    // A node's depth is its key length; the root is the empty key.
    const depths = new Set(index.leaves.map((l) => l.key.length));
    expect(depths.size).toBeGreaterThan(1);
    expect(index.depth).toBeGreaterThan(0);
  });

  it('populates the coarse levels, so a preview exists before the leaves', async () => {
    const capacity = 10_000;
    const { index } = await build(200_000, capacity);
    const byKey = new Map(index.leaves.map((l) => [l.key, l.pointCount]));
    // The root holds a coarse sample of the whole cloud: something is drawable
    // immediately. Its size is a hash-selected fraction of the cloud, bounded by
    // the node capacity, not the arrival-order fill of the old build.
    const root = byKey.get('') ?? 0;
    expect(root).toBeGreaterThan(0);
    expect(root).toBeLessThanOrEqual(capacity);
    // Level-1 cells exist and carry a coarse sample too, so the pyramid draws
    // coarse-before-fine. Each stays within capacity.
    const levelOne = [...byKey.entries()].filter(([k]) => k.length === 1);
    expect(levelOne.length).toBeGreaterThan(0);
    for (const [, n] of levelOne) {
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(capacity);
    }
  });

  it('never exceeds the node capacity except at the deepest level, which takes the overflow', async () => {
    const capacity = 10_000;
    const { index } = await build(200_000, capacity);
    for (const leaf of index.leaves) {
      if (leaf.key.length < index.depth) {
        // An interior node is capacity-bounded, which is what keeps a coarse
        // level cheap enough to draw within a point budget.
        expect(leaf.pointCount).toBeLessThanOrEqual(capacity);
      }
    }
  });

  it('still conserves every point exactly once across the whole pyramid', async () => {
    const count = 200_000;
    const { index, store } = await build(count, 10_000);
    expect(index.pointCount).toBe(count);
    expect(index.leaves.reduce((n, l) => n + l.pointCount, 0)).toBe(count);
    expect(store.totalBytes()).toBe(count * RECORD_BYTES);
  });

  it('keeps every point inside the cube of the node it settled in, at any depth', async () => {
    const { index, store } = await build(200_000, 10_000);
    let violations = 0;
    let checked = 0;
    for (const leaf of index.leaves) {
      const cube = index.grid.cubeFor(leaf.key);
      const bytes = await store.read(leaf.key);
      const xyz = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      for (let i = 0; i < xyz.length; i += 3) {
        const inside =
          xyz[i] >= cube.min[0] && xyz[i] <= cube.min[0] + cube.size &&
          xyz[i + 1] >= cube.min[1] && xyz[i + 1] <= cube.min[1] + cube.size &&
          xyz[i + 2] >= cube.min[2] && xyz[i + 2] <= cube.min[2] + cube.size;
        if (!inside) violations++;
        checked++;
      }
    }
    expect(checked).toBe(200_000);
    expect(violations).toBe(0);
  });

  it('a cloud that fits in one node stays a single root node', async () => {
    const { index } = await build(5_000, 100_000);
    expect(index.leaves).toHaveLength(1);
    expect(index.leaves[0].key).toBe('');
  });
});
