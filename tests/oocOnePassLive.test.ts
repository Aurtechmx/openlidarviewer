/**
 * oocOnePassLive.test.ts — the one-pass fast path fires through the REAL
 * production entry, not just the synthetic indexer test.
 *
 * The single-pass build is enabled by two live pieces: `openSlicedLasSource`
 * attaching a trusted `header` in the stored origin-relative Float32 frame, and
 * `opfsSpillStore` exposing a `clear()` so a rejected header can roll back. These
 * tests drive a real uncompressed LAS through `openSlicedLasSource` +
 * `indexOutOfCore` and through `buildTileStoreFromLas`, and assert:
 *
 *   1. a valid-header LAS is read ONCE (one pass), where two passes read twice;
 *   2. the fast build is byte-identical to a forced two-pass build — same nodes,
 *      per-node counts, every tile's bytes, and the manifest and hierarchy;
 *   3. `opfsSpillStore().clear()` removes every spilled tile;
 *   4. a degenerate (single-value bbox) LAS still takes two passes.
 */
import { describe, it, expect } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { indexOutOfCore, type OocIndex, type SpillStore } from '../src/io/heavy/oocIndexer';
import { openSlicedLasSource } from '../src/io/heavy/slicedLasSource';
import { buildTileStore } from '../src/io/heavy/tileStore';
import { buildTileStoreFromLas } from '../src/io/heavy/tileStoreBuilder';
import { opfsSpillStore } from '../src/io/heavy/opfsSpillStore';
import { fakeOpfsDir } from './support/fakeOpfs';

/** A memory spill store with `clear`, so the fast path may run in Node. */
function clearableStore(): SpillStore & { cleared: number } {
  const parts = new Map<string, Uint8Array[]>();
  const store = {
    cleared: 0,
    async append(key: string, bytes: Uint8Array) {
      (parts.get(key) ?? parts.set(key, []).get(key)!).push(bytes.slice());
    },
    async read(key: string) {
      const arr = parts.get(key) ?? [];
      const out = new Uint8Array(arr.reduce((n, b) => n + b.byteLength, 0));
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
  };
  return store;
}

const WORLD_MIN = [500000, 4100000, 190] as const;

/** N points spread over a real box, distinct intensity labels. */
function labelledCloud(n: number, spread = true): GlobalPoints {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = WORLD_MIN[0] + (spread ? (i % 137) * 1.5 : 0);
    y[i] = WORLD_MIN[1] + (spread ? Math.floor(i / 137) * 1.5 : 0);
    z[i] = WORLD_MIN[2] + (spread ? (i % 23) * 0.25 : 0);
    intensity[i] = i & 0xffff;
    classification[i] = 2;
  }
  return { count: n, x, y, z, intensity, classification };
}

function lasRange(cloud: GlobalPoints): ArrayBufferRangeSource {
  const bytes = writeLas14(cloud);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new ArrayBufferRangeSource(ab);
}

/** A RangeSource that counts the point-data bytes read, to tell one pass from two. */
function countingRange(inner: ArrayBufferRangeSource): {
  range: ArrayBufferRangeSource;
  bytesRead(): number;
} {
  let bytes = 0;
  const range = {
    size: () => inner.size(),
    async readRange(offset: number, length: number, signal?: AbortSignal) {
      bytes += length;
      return inner.readRange(offset, length, signal);
    },
  } as unknown as ArrayBufferRangeSource;
  return { range, bytesRead: () => bytes };
}

/** Every tile's bytes, keyed, so two stores can be compared exactly. */
async function tiles(store: SpillStore, index: OocIndex): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const leaf of index.leaves) {
    out.set(leaf.key, Buffer.from(await store.read(leaf.key)).toString('hex'));
  }
  return out;
}

function shape(index: OocIndex) {
  return {
    root: index.grid.root,
    depth: index.depth,
    pointCount: index.pointCount,
    bounds: index.bounds,
    recordBytes: index.recordBytes,
    leaves: index.leaves.map((l) => ({ key: l.key, pointCount: l.pointCount })),
  };
}

describe('one-pass fast path through the live LAS entry', () => {
  it('attaches a header in the exact stored Float32 frame', async () => {
    const las = await openSlicedLasSource(lasRange(labelledCloud(5000)));
    expect(las.source.header).toBeDefined();
    const h = las.source.header!;
    // Point count is the readable count, so it equals what a bounds pass counts.
    expect(h.pointCount).toBe(las.readablePointCount);
    // Bounds are the header world bounds, moved into the origin-relative frame
    // and Float32-rounded exactly as the stored positions are.
    const seenMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const seenMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for await (const b of las.source.batches()) {
      for (let i = 0; i < b.count; i++) {
        for (let a = 0; a < 3; a++) {
          const v = b.positions[i * 3 + a];
          if (v < seenMin[a]) seenMin[a] = v;
          if (v > seenMax[a]) seenMax[a] = v;
        }
      }
    }
    expect([h.min[0], h.min[1], h.min[2]]).toEqual(seenMin);
    expect([h.max[0], h.max[1], h.max[2]]).toEqual(seenMax);
  });

  it('reads each point ONCE through openSlicedLasSource + indexOutOfCore', async () => {
    const counting = countingRange(lasRange(labelledCloud(8000)));
    const las = await openSlicedLasSource(counting.range);
    const store = clearableStore();
    await indexOutOfCore(las.source, store, { pointsPerLeaf: 800, memoryBudgetBytes: 64 * 1024 });
    const onePass = counting.bytesRead();

    const counting2 = countingRange(lasRange(labelledCloud(8000)));
    const las2 = await openSlicedLasSource(counting2.range);
    await indexOutOfCore(las2.source, clearableStore(), {
      pointsPerLeaf: 800,
      memoryBudgetBytes: 64 * 1024,
      forceSlowPath: true,
    });
    const twoPass = counting2.bytesRead();

    // Two passes read the point data roughly twice; one pass reads it once.
    expect(onePass).toBeLessThan(twoPass * 0.75);
    expect(store.cleared).toBe(0); // exact header, no rollback
  });

  it('fast build is byte-identical to a forced two-pass build', async () => {
    const opts = { pointsPerLeaf: 800, memoryBudgetBytes: 64 * 1024 } as const;

    const fastLas = await openSlicedLasSource(lasRange(labelledCloud(8000)));
    const fastStore = clearableStore();
    const fast = await indexOutOfCore(fastLas.source, fastStore, opts);

    const slowLas = await openSlicedLasSource(lasRange(labelledCloud(8000)));
    const slowStore = clearableStore();
    const slow = await indexOutOfCore(slowLas.source, slowStore, { ...opts, forceSlowPath: true });

    expect(shape(fast)).toEqual(shape(slow));
    expect(await tiles(fastStore, fast)).toEqual(await tiles(slowStore, slow));

    const a = buildTileStore(fast, fastLas.schema, fastLas.origin);
    const b = buildTileStore(slow, slowLas.schema, slowLas.origin);
    expect(a.manifestJson).toBe(b.manifestJson);
    expect(a.hierarchy).toBe(b.hierarchy);
  });

  it('buildTileStoreFromLas fires the fast path with byte-identical output', async () => {
    const opts = { pointsPerLeaf: 800, memoryBudgetBytes: 64 * 1024 } as const;

    const counting = countingRange(lasRange(labelledCloud(8000)));
    const fastSpill = clearableStore();
    const fast = await buildTileStoreFromLas(counting.range, fastSpill, opts);
    const onePass = counting.bytesRead();

    const countingSlow = countingRange(lasRange(labelledCloud(8000)));
    const slowSpill = clearableStore();
    const slow = await buildTileStoreFromLas(countingSlow.range, slowSpill, {
      ...opts,
      forceSlowPath: true,
    });
    const twoPass = countingSlow.bytesRead();

    // The production entry really took one pass.
    expect(onePass).toBeLessThan(twoPass * 0.75);
    expect(fastSpill.cleared).toBe(0);

    // Same artifacts, and same tile bytes for every leaf.
    expect(fast.manifestJson).toBe(slow.manifestJson);
    expect(fast.hierarchy).toBe(slow.hierarchy);
    for (const leaf of fast.reader.leaves()) {
      const fa = Buffer.from(await fast.tiles.read(leaf.key)).toString('hex');
      const sb = Buffer.from(await slow.tiles.read(leaf.key)).toString('hex');
      expect(fa).toBe(sb);
    }
  });

  it('opfsSpillStore().clear() removes every spilled tile', async () => {
    const dir = fakeOpfsDir();
    const store = opfsSpillStore(dir);
    await store.append('0', new Uint8Array([1, 2, 3]));
    await store.append('12', new Uint8Array([4, 5]));
    await store.append('', new Uint8Array([6])); // the root tile
    await store.close();
    expect((await store.keys()).sort()).toEqual(['', '0', '12']);

    await store.clear!();
    expect(await store.keys()).toEqual([]);
    // No tile files remain in the directory.
    const names: string[] = [];
    for await (const name of dir.keys()) names.push(name);
    expect(names.filter((n) => n.endsWith('.tile'))).toEqual([]);
  });

  it('a degenerate single-value LAS still takes two passes', async () => {
    const counting = countingRange(lasRange(labelledCloud(2000, false)));
    const las = await openSlicedLasSource(counting.range);
    // A zero-extent cloud has no usable header, so none is attached.
    expect(las.source.header).toBeUndefined();
    const store = clearableStore();
    await indexOutOfCore(las.source, store, { pointsPerLeaf: 500, memoryBudgetBytes: 64 * 1024 });
    expect(store.cleared).toBe(0);
  });
});
