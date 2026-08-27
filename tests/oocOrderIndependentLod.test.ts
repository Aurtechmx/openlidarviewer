/**
 * oocOrderIndependentLod.test.ts — the LOD membership must not depend on the
 * order records arrive in.
 *
 * The out-of-core indexer fills its coarse octree nodes as it streams the file.
 * If which points represent a coarse node is decided by arrival order, the first
 * low-resolution view is biased toward the start of the file — for a flightline-
 * ordered airborne LAS that is one side of the survey. The fix makes coarse-node
 * membership a pure function of each point's position, so the same cloud fed in
 * any order produces the same node-to-points assignment.
 *
 * These tests pin three properties of that fix:
 *   1. order independence — the same points in a different order (reversed, or
 *      sorted into a flightline block) yield the SAME per-node membership;
 *   2. determinism — the same input in the same order twice is byte-identical;
 *   3. conservation — every point lands in exactly one node, totals sum to the
 *      source count, in every order.
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

/** A fixed cloud of distinct points, deterministic across calls. */
function makeCloud(count: number): Float32Array {
  const pts = new Float32Array(count * 3);
  let s = 123456789 >>> 0;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    pts[i * 3] = 500000 + rnd() * 1000;
    pts[i * 3 + 1] = 4100000 + rnd() * 600;
    pts[i * 3 + 2] = 190 + rnd() * 70;
  }
  return pts;
}

/** Yield a cloud in the order given by `order`, in fixed-size batches. */
function sourceInOrder(pts: Float32Array, order: Uint32Array, batchPoints: number): PointSource {
  const count = order.length;
  return {
    async *batches() {
      for (let first = 0; first < count; first += batchPoints) {
        const n = Math.min(batchPoints, count - first);
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const p = order[first + i];
          positions[i * 3] = pts[p * 3];
          positions[i * 3 + 1] = pts[p * 3 + 1];
          positions[i * 3 + 2] = pts[p * 3 + 2];
        }
        yield { positions, count: n };
      }
    },
  };
}

const REC = 12; // three float32 xyz per point

/** Per-node membership as a sorted multiset of "x,y,z" strings, keyed by node. */
async function membership(store: SpillStore, keys: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const key of keys) {
    const bytes = await store.read(key);
    const xyz = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const pts: string[] = [];
    for (let i = 0; i < xyz.length; i += 3) pts.push(`${xyz[i]},${xyz[i + 1]},${xyz[i + 2]}`);
    pts.sort();
    out.set(key, pts);
  }
  return out;
}

function identity(count: number): Uint32Array {
  const a = new Uint32Array(count);
  for (let i = 0; i < count; i++) a[i] = i;
  return a;
}

function reversed(count: number): Uint32Array {
  const a = identity(count);
  return a.reverse();
}

/** Sort point indices by x, so the file reads as one flightline strip after another. */
function flightlineBlocked(pts: Float32Array, count: number): Uint32Array {
  const a = [...identity(count)];
  a.sort((i, j) => pts[i * 3] - pts[j * 3]);
  return Uint32Array.from(a);
}

const OPTS = { pointsPerLeaf: 10_000, memoryBudgetBytes: 256 * 1024 } as const;

async function buildInOrder(pts: Float32Array, order: Uint32Array) {
  const store = memoryStore();
  const index = await indexOutOfCore(sourceInOrder(pts, order, 20_000), store, OPTS);
  const keys = index.leaves.map((l) => l.key).sort();
  return { store, index, keys, member: await membership(store, keys) };
}

describe('out-of-core LOD — order independence', () => {
  it('assigns the same points to the same nodes regardless of arrival order', async () => {
    const count = 200_000;
    const pts = makeCloud(count);

    const forward = await buildInOrder(pts, identity(count));
    const backward = await buildInOrder(pts, reversed(count));
    const blocked = await buildInOrder(pts, flightlineBlocked(pts, count));

    // Same set of node keys.
    expect(backward.keys).toEqual(forward.keys);
    expect(blocked.keys).toEqual(forward.keys);

    // Same per-node membership: which points represent each node does not depend
    // on the order the file delivered them.
    for (const key of forward.keys) {
      expect(backward.member.get(key)).toEqual(forward.member.get(key));
      expect(blocked.member.get(key)).toEqual(forward.member.get(key));
    }
  });

  it('is deterministic: the same input twice is byte-identical', async () => {
    const count = 120_000;
    const pts = makeCloud(count);
    const a = await buildInOrder(pts, identity(count));
    const b = await buildInOrder(pts, identity(count));

    expect(b.keys).toEqual(a.keys);
    for (const key of a.keys) {
      const ba = await a.store.read(key);
      const bb = await b.store.read(key);
      expect(Buffer.from(bb).toString('hex')).toBe(Buffer.from(ba).toString('hex'));
    }
  });

  it('conserves every point exactly once, in every order', async () => {
    const count = 200_000;
    const pts = makeCloud(count);
    for (const order of [identity(count), reversed(count), flightlineBlocked(pts, count)]) {
      const { index, store } = await buildInOrder(pts, order);
      expect(index.pointCount).toBe(count);
      expect(index.leaves.reduce((n, l) => n + l.pointCount, 0)).toBe(count);
      expect(store.totalBytes()).toBe(count * REC);
    }
  });
});
