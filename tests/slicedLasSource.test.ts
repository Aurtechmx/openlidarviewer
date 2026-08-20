/**
 * slicedLasSource.test.ts — a real uncompressed LAS through the out-of-core
 * indexer, with every attribute checked on the way back out.
 *
 * A LAS is written with the real writer, its points given per-point-distinct
 * attributes keyed to the point's intensity (`intensity[i] = i`), so after the
 * indexer has scattered them across leaf tiles each record can be identified and
 * every field cross-checked. The build runs against a memory spill store, so the
 * whole path — sliced read, tile packing, two-pass bucketing, tile read — is
 * exercised in Node.
 */
import { describe, it, expect } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { indexOutOfCore, type SpillStore } from '../src/io/heavy/oocIndexer';
import { openSlicedLasSource } from '../src/io/heavy/slicedLasSource';
import { readTileRecord } from '../src/io/heavy/tileRecord';

function memoryStore(): SpillStore {
  const parts = new Map<string, Uint8Array[]>();
  return {
    async append(key, bytes) {
      (parts.get(key) ?? parts.set(key, []).get(key)!).push(bytes.slice());
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
  };
}

const CLASSES = [2, 3, 4, 5, 6];

/** N points on a grid, every attribute a deterministic function of the index i. */
function labelledCloud(n: number): GlobalPoints {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const intensity = new Uint16Array(n);
  const returnNumber = new Uint8Array(n);
  const returnCount = new Uint8Array(n);
  const classification = new Uint8Array(n);
  const pointSourceId = new Uint16Array(n);
  const gpsTime = new Float64Array(n);
  const colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    x[i] = 500000 + (i % 100) * 2;
    y[i] = 4100000 + Math.floor(i / 100) * 2;
    z[i] = 190 + (i % 50);
    intensity[i] = i; // the label
    returnCount[i] = (i % 3) + 1;
    returnNumber[i] = (i % returnCount[i]) + 1;
    classification[i] = CLASSES[i % CLASSES.length];
    pointSourceId[i] = 7;
    gpsTime[i] = 1000 + i * 0.001;
    colors[i * 3] = i & 0xff;
    colors[i * 3 + 1] = (i >> 8) & 0xff;
    colors[i * 3 + 2] = 42;
  }
  return { count: n, x, y, z, intensity, returnNumber, returnCount, classification, pointSourceId, gpsTime, colors };
}

describe('sliced LAS source → out-of-core indexer', () => {
  it('buckets a real LAS and round-trips every attribute through the tiles', async () => {
    const n = 10_000; // <= 65536 so intensity can label every point uniquely
    const bytes = writeLas14(labelledCloud(n));
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const range = new ArrayBufferRangeSource(ab);

    const las = await openSlicedLasSource(range);
    // Point format 7: RGB + GPS, so records carry both (19 + 8 + 3 = 30 bytes).
    expect(las.schema).toEqual({ hasGps: true, hasRgb: true });
    expect(las.recordBytes).toBe(30);
    expect(las.readablePointCount).toBe(n);

    const store = memoryStore();
    const index = await indexOutOfCore(las.source, store, {
      pointsPerLeaf: 1500,
      memoryBudgetBytes: 64 * 1024,
    });

    // Conservation and a genuine split.
    expect(index.pointCount).toBe(n);
    expect(index.recordBytes).toBe(30);
    expect(index.depth).toBeGreaterThan(0);
    expect(index.leaves.reduce((s, l) => s + l.pointCount, 0)).toBe(n);

    // Read every tile, unpack every record, and verify the whole record against
    // its own intensity label — position inside the leaf cube, and each field
    // the exact deterministic function of i the cloud was built with.
    const seen = new Set<number>();
    let posViolations = 0;
    let attrViolations = 0;
    for (const leaf of index.leaves) {
      const cube = index.grid.cubeFor(leaf.key);
      const tile = await store.read(leaf.key);
      const view = new DataView(tile.buffer, tile.byteOffset, tile.byteLength);
      expect(tile.byteLength).toBe(leaf.pointCount * 30);
      for (let r = 0; r < leaf.pointCount; r++) {
        const pt = readTileRecord(view, r * 30, las.schema);
        const i = pt.intensity;
        seen.add(i);
        for (let a = 0; a < 3; a++) {
          if (pt.position[a] < cube.min[a] || pt.position[a] > cube.min[a] + cube.size) posViolations++;
        }
        if (
          pt.classification !== CLASSES[i % CLASSES.length] ||
          pt.returnCount !== (i % 3) + 1 ||
          pt.pointSourceId !== 7 ||
          Math.abs((pt.gpsTime ?? -1) - (1000 + i * 0.001)) > 1e-6 ||
          !pt.rgb ||
          pt.rgb[0] !== (i & 0xff) ||
          pt.rgb[1] !== ((i >> 8) & 0xff) ||
          pt.rgb[2] !== 42
        ) {
          attrViolations++;
        }
      }
    }
    expect(posViolations).toBe(0);
    expect(attrViolations).toBe(0);
    // Every point present exactly once: the label set is 0..n-1.
    expect(seen.size).toBe(n);
  });
});
