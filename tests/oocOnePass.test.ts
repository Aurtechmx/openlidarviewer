/**
 * oocOnePass.test.ts — the single-pass out-of-core build and its guards.
 *
 * When a source exposes a trusted header (a finite count and a non-degenerate
 * bounding box), the indexer skips the bounds pass and builds the octree in ONE
 * read instead of two. The tests here pin the four properties that make that safe
 * to run beside the two-pass path:
 *
 *   1. a valid header is read once, not twice;
 *   2. the fast index is byte-for-byte the two-pass index — same nodes, per-node
 *      counts, tile bytes, and manifest;
 *   3. a header whose bounds a point escapes is rejected, and the build rebuilds
 *      from measured bounds to the exact two-pass result;
 *   4. a source with no usable header takes the two-pass path unchanged.
 *
 * A memory spill store with `clear` stands in for OPFS, so the whole build and
 * its rollback run in Node.
 */
import { describe, it, expect } from 'vitest';
import {
  indexOutOfCore,
  type OocIndex,
  type PointSource,
  type SourceHeader,
  type SpillStore,
} from '../src/io/heavy/oocIndexer';
import { buildTileStore } from '../src/io/heavy/tileStore';
import type { TileSchema } from '../src/io/heavy/tileRecord';

/** An in-memory {@link SpillStore} that can be cleared, so the fast path may run. */
function clearableStore(): SpillStore & { totalBytes(): number; cleared: number } {
  const parts = new Map<string, Uint8Array[]>();
  const store = {
    cleared: 0,
    async append(key: string, bytes: Uint8Array) {
      const arr = parts.get(key) ?? [];
      arr.push(bytes.slice());
      parts.set(key, arr);
    },
    async read(key: string) {
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
    async clear() {
      parts.clear();
      store.cleared += 1;
    },
    totalBytes() {
      let n = 0;
      for (const arr of parts.values()) for (const b of arr) n += b.byteLength;
      return n;
    },
  };
  return store;
}

/** Same store shape, but WITHOUT `clear` — a store the fast path must decline. */
function plainStore(): SpillStore {
  const s = clearableStore();
  return { append: s.append, read: s.read, keys: s.keys };
}

const RECORD_BYTES = 19; // BASE_BYTES for a hasGps:false, hasRgb:false tile schema
const SCHEMA: TileSchema = { hasGps: false, hasRgb: false };
const ORIGIN: [number, number, number] = [0, 0, 0];

/**
 * A deterministic cloud that COUNTS how many point-records it decodes across all
 * `batches()` iterations, so a test can tell one pass from two. Positions are
 * packed into the first 12 bytes of each 19-byte record, so the store is a real
 * tile store the manifest builder accepts.
 */
function countingSource(
  count: number,
  batchPoints: number,
  headerFor: (min: [number, number, number], max: [number, number, number]) => SourceHeader | undefined,
): PointSource & { reads: number; outlier?: [number, number, number] } {
  const pts = new Float32Array(count * 3);
  let s = 987654321 >>> 0;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const x = 500000 + rnd() * 1000;
    const y = 4100000 + rnd() * 600;
    const z = 190 + rnd() * 70;
    pts[i * 3] = x;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = z;
    for (let a = 0; a < 3; a++) {
      const v = pts[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }

  const src: PointSource & { reads: number; outlier?: [number, number, number] } = {
    reads: 0,
    header: headerFor(min, max),
    async *batches(signal) {
      for (let first = 0; first < count; first += batchPoints) {
        signal?.throwIfAborted();
        const n = Math.min(batchPoints, count - first);
        const positions = new Float32Array(n * 3);
        const records = new Uint8Array(n * RECORD_BYTES);
        const view = new DataView(records.buffer);
        for (let i = 0; i < n; i++) {
          positions.set(pts.subarray((first + i) * 3, (first + i) * 3 + 3), i * 3);
          view.setFloat32(i * RECORD_BYTES + 0, positions[i * 3], true);
          view.setFloat32(i * RECORD_BYTES + 4, positions[i * 3 + 1], true);
          view.setFloat32(i * RECORD_BYTES + 8, positions[i * 3 + 2], true);
          view.setUint16(i * RECORD_BYTES + 12, (first + i) & 0xffff, true); // intensity, distinguishes records
        }
        src.reads += n;
        yield { positions, count: n, records, recordBytes: RECORD_BYTES };
      }
    },
  };
  return src;
}

/** The exact-header source: header bounds equal the measured Float32 extrema. */
function exactSource(count: number, batchPoints: number) {
  return countingSource(count, batchPoints, (min, max) => ({ pointCount: count, min, max }));
}

/** Deep-comparable view of an index: the data that must be identical, minus closures. */
function shape(index: OocIndex) {
  return {
    root: index.grid.root,
    depth: index.depth,
    pointCount: index.pointCount,
    bounds: index.bounds,
    recordBytes: index.recordBytes,
    peakBufferedBytes: index.peakBufferedBytes,
    leaves: [...index.leaves].map((l) => ({ key: l.key, pointCount: l.pointCount })),
  };
}

/** Every tile's bytes, keyed, so two stores can be compared exactly. */
async function tiles(store: SpillStore, index: OocIndex): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const leaf of index.leaves) {
    const bytes = await store.read(leaf.key);
    out.set(leaf.key, Buffer.from(bytes).toString('hex'));
  }
  return out;
}

describe('single-pass out-of-core build', () => {
  it('reads each point ONCE for a valid-header source', async () => {
    const count = 200_000;
    const src = exactSource(count, 20_000);
    const store = clearableStore();

    await indexOutOfCore(src, store, { pointsPerLeaf: 10_000, memoryBudgetBytes: 256 * 1024 });

    // Two passes would decode 2 * count records. One pass decodes exactly count.
    expect(src.reads).toBe(count);
  });

  it('produces a byte-for-byte identical index to the two-pass path', async () => {
    const count = 200_000;
    const opts = { pointsPerLeaf: 10_000, memoryBudgetBytes: 256 * 1024 } as const;

    const fastStore = clearableStore();
    const fast = await indexOutOfCore(exactSource(count, 20_000), fastStore, opts);

    const slowSrc = exactSource(count, 20_000);
    const slowStore = clearableStore();
    const slow = await indexOutOfCore(slowSrc, slowStore, { ...opts, forceSlowPath: true });

    // The forced path really did read twice; the fast one really did not.
    expect(slowSrc.reads).toBe(count * 2);

    // 1. Same nodes and per-node counts, same bounds, same peak memory.
    expect(shape(fast)).toEqual(shape(slow));
    // 2. Same tile bytes for every key.
    expect(await tiles(fastStore, fast)).toEqual(await tiles(slowStore, slow));
    // 3. Same manifest and hierarchy.
    const a = buildTileStore(fast, SCHEMA, ORIGIN);
    const b = buildTileStore(slow, SCHEMA, ORIGIN);
    expect(a.manifestJson).toBe(b.manifestJson);
    expect(a.hierarchy).toBe(b.hierarchy);
  });

  it('rejects a header whose bounds a point escapes and rebuilds the two-pass index', async () => {
    const count = 120_000;
    const opts = { pointsPerLeaf: 8_000, memoryBudgetBytes: 128 * 1024 } as const;

    // A header that under-declares the box: shrink max so real points fall outside.
    const liar = countingSource(count, 15_000, (min, max) => ({
      pointCount: count,
      min,
      max: [max[0] - 200, max[1] - 120, max[2] - 15],
    }));
    const liarStore = clearableStore();
    const fromLiar = await indexOutOfCore(liar, liarStore, opts);

    // The fast attempt aborted (store was cleared) and re-read from the start.
    expect(liarStore.cleared).toBeGreaterThan(0);

    // The result equals what a pure two-pass build makes from the honest points.
    const honestSrc = exactSource(count, 15_000);
    const honestStore = clearableStore();
    const honest = await indexOutOfCore(honestSrc, honestStore, { ...opts, forceSlowPath: true });

    expect(shape(fromLiar)).toEqual(shape(honest));
    expect(await tiles(liarStore, fromLiar)).toEqual(await tiles(honestStore, honest));
  });

  it('aborts EARLY when the escaping point is in the first batch (does not finish the fast pass)', async () => {
    const count = 100_000;
    const batch = 10_000;
    // Under-declare the box so the very first batch already holds outliers.
    const liar = countingSource(count, batch, (min, max) => ({
      pointCount: count,
      min,
      max: [max[0] - 300, max[1], max[2]],
    }));
    const store = clearableStore();
    await indexOutOfCore(liar, store, { pointsPerLeaf: 8_000, memoryBudgetBytes: 128 * 1024 });

    // reads = (short fast attempt that stopped inside the first batch) + full slow 2 passes.
    // If the fast attempt had run to the end it would be batch..count before failing,
    // pushing reads to 3 * count. Early abort keeps it well under that.
    expect(store.cleared).toBeGreaterThan(0);
    expect(liar.reads).toBeLessThan(count * 3);
    expect(liar.reads).toBeLessThanOrEqual(count * 2 + batch);
  });

  it('takes the two-pass path unchanged when the header is missing', async () => {
    const count = 80_000;
    const noHeader = countingSource(count, 10_000, () => undefined);
    const store = clearableStore();
    await indexOutOfCore(noHeader, store, { pointsPerLeaf: 8_000, memoryBudgetBytes: 128 * 1024 });
    expect(noHeader.reads).toBe(count * 2);
    expect(store.cleared).toBe(0);
  });

  it('takes the two-pass path when the header bounds are degenerate', async () => {
    const count = 40_000;
    // Zero-extent box: min === max. Not usable, so no fast path.
    const degen = countingSource(count, 10_000, (min) => ({ pointCount: count, min, max: min }));
    const store = clearableStore();
    await indexOutOfCore(degen, store, { pointsPerLeaf: 8_000, memoryBudgetBytes: 128 * 1024 });
    expect(store.cleared).toBe(0);
    expect(degen.reads).toBe(count * 2);
  });

  it('falls back on a superset header whose grid differs, and still equals the two-pass index', async () => {
    const count = 90_000;
    const opts = { pointsPerLeaf: 8_000, memoryBudgetBytes: 128 * 1024 } as const;
    // Bounds strictly contain every point but are larger, so the grid the header
    // builds is not the grid measured bounds build. No point escapes, so only the
    // post-pass grid check catches it.
    const superset = countingSource(count, 15_000, (min, max) => ({
      pointCount: count,
      min: [min[0] - 500, min[1] - 500, min[2] - 500],
      max: [max[0] + 500, max[1] + 500, max[2] + 500],
    }));
    const supStore = clearableStore();
    const fromSuperset = await indexOutOfCore(superset, supStore, opts);
    expect(supStore.cleared).toBeGreaterThan(0);

    const honestStore = clearableStore();
    const honest = await indexOutOfCore(exactSource(count, 15_000), honestStore, {
      ...opts,
      forceSlowPath: true,
    });
    expect(shape(fromSuperset)).toEqual(shape(honest));
    expect(await tiles(supStore, fromSuperset)).toEqual(await tiles(honestStore, honest));
  });

  it('declines the fast path on a store that cannot be cleared (two passes, correct)', async () => {
    const count = 60_000;
    const opts = { pointsPerLeaf: 8_000, memoryBudgetBytes: 128 * 1024 } as const;
    const src = exactSource(count, 10_000);
    await indexOutOfCore(src, plainStore(), opts);
    // No clear() means no safe rollback, so the build stays two-pass.
    expect(src.reads).toBe(count * 2);
  });
});
