/**
 * oocIndexerAllocatedBudget.test.ts — the bucketing pass budgets on ALLOCATED
 * backing-array capacity, not just logical record bytes.
 *
 * The staging buffers grow by doubling and, before the fix, a flush zeroed a
 * buffer's length but kept its multi-megabyte backing array, and never dropped
 * the buffer from the map. Across flush windows that retained a grown array per
 * leaf key plus a fresh 4 KiB buffer per new key, none of it counted against the
 * budget, so the advertised bounded staging budget was not a real heap bound.
 *
 * These cases pin the real bound: with THOUSANDS of unique leaf keys and several
 * keys that each accumulate multiple megabytes across different flush windows,
 * the peak ALLOCATED capacity (what `peakBufferedBytes` now reports) stays within
 * the configured budget, and the store still holds every point exactly once.
 */
import { describe, it, expect } from 'vitest';
import { indexOutOfCore, type PointSource, type SpillStore } from '../src/io/heavy/oocIndexer';

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

/**
 * A deterministic cloud whose points cluster around many centres: hundreds of
 * clusters give thousands of leaf keys, and heavy per-cluster volume makes
 * several keys each accumulate multiple megabytes of records across successive
 * flush windows — the exact shape that made the old per-leaf backing arrays pile
 * up uncounted.
 */
function clusteredSource(count: number, batchPoints: number, clusters: number): PointSource {
  return {
    async *batches() {
      let s = 2246822519 >>> 0;
      const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
      let emitted = 0;
      while (emitted < count) {
        const n = Math.min(batchPoints, count - emitted);
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const c = (emitted + i) % clusters;
          const cx = 500000 + (c % 40) * 25;
          const cy = 4100000 + Math.floor(c / 40) * 25;
          positions[i * 3] = cx + rnd() * 2;
          positions[i * 3 + 1] = cy + rnd() * 2;
          positions[i * 3 + 2] = 190 + rnd() * 40;
        }
        emitted += n;
        yield { positions, count: n };
      }
    },
  };
}

const RECORD_BYTES = 12;

describe('out-of-core indexer — allocated-capacity staging budget', () => {
  it('keeps peak ALLOCATED capacity within budget across thousands of keys and many flush windows', async () => {
    const count = 3_000_000;
    const budget = 2 * 1024 * 1024; // 2 MiB, far below the ~36 MB logical stream
    const store = memoryStore();

    const index = await indexOutOfCore(clusteredSource(count, 50_000, 1500), store, {
      pointsPerLeaf: 400,
      memoryBudgetBytes: budget,
    });

    // Thousands of distinct nodes across the pyramid, many flush windows.
    expect(index.leaves.length).toBeGreaterThan(1000);

    // The real bound: peak allocated backing-array capacity never exceeds the
    // configured budget. The old accounting counted logical bytes and let flush
    // retain grown arrays, so this was violated (peak reported budget + record,
    // and the true retained capacity climbed without bound).
    expect(index.peakBufferedBytes).toBeLessThanOrEqual(budget);

    // Conservation still holds: every point spilled exactly once.
    expect(index.pointCount).toBe(count);
    expect(index.leaves.reduce((n, l) => n + l.pointCount, 0)).toBe(count);
    expect(store.totalBytes()).toBe(count * RECORD_BYTES);
  });
});
