/**
 * tileStore.test.ts — the store round-trips through its own reader, and the tree
 * is knowable without touching a tile.
 *
 * An index built from a real LAS is written to a manifest and a hierarchy, both
 * are parsed back, and the reader rebuilt from them alone reproduces the grid and
 * every leaf count with no tile read. A tile is then decoded to confirm its bytes
 * still describe the points that were bucketed into it. Fail-closed parsing is
 * checked on a corrupted manifest and a corrupted hierarchy line.
 */
import { describe, it, expect } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { indexOutOfCore, type SpillStore } from '../src/io/heavy/oocIndexer';
import { openSlicedLasSource } from '../src/io/heavy/slicedLasSource';
import {
  buildTileStore,
  parseHierarchy,
  parseTileManifest,
  TileStoreReader,
} from '../src/io/heavy/tileStore';

function memoryStore(): SpillStore {
  const parts = new Map<string, Uint8Array[]>();
  return {
    async append(key, bytes) {
      (parts.get(key) ?? parts.set(key, []).get(key)!).push(bytes.slice());
    },
    async read(key) {
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
  };
}

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
    x[i] = 500000 + (i % 80) * 3;
    y[i] = 4100000 + Math.floor(i / 80) * 3;
    z[i] = 190 + (i % 40);
    intensity[i] = i;
    returnCount[i] = 1;
    returnNumber[i] = 1;
    classification[i] = 2;
    pointSourceId[i] = 5;
    gpsTime[i] = 500 + i * 0.01;
    colors[i * 3] = i & 0xff;
    colors[i * 3 + 1] = (i >> 8) & 0xff;
    colors[i * 3 + 2] = 9;
  }
  return { count: n, x, y, z, intensity, returnNumber, returnCount, classification, pointSourceId, gpsTime, colors };
}

async function buildIndex(n: number) {
  const bytes = writeLas14(labelledCloud(n));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const las = await openSlicedLasSource(new ArrayBufferRangeSource(ab));
  const store = memoryStore();
  const index = await indexOutOfCore(las.source, store, { pointsPerLeaf: 800, memoryBudgetBytes: 32 * 1024 });
  return { index, store, schema: las.schema, origin: las.origin };
}

describe('tile store', () => {
  it('round-trips the manifest and hierarchy and reads a tile back', async () => {
    const n = 5000;
    const { index, store, schema, origin } = await buildIndex(n);
    const { manifest, manifestJson, hierarchy } = buildTileStore(index, schema, origin);

    // The recentring origin survives the round trip: without it a reader would
    // present source-local float32 as world coordinates.
    expect(manifest.origin).toEqual(origin);

    // Manifest round-trips through its own parser, byte-shaped as JSON.
    expect(parseTileManifest(JSON.parse(manifestJson))).toEqual(manifest);
    expect(manifest.pointCount).toBe(n);
    expect(manifest.recordBytes).toBe(30);
    expect(manifest.leafCount).toBe(index.leaves.length);

    // Hierarchy parses to the same leaves the index has — no tile read involved.
    const leaves = parseHierarchy(hierarchy);
    expect(leaves.length).toBe(index.leaves.length);
    expect(leaves.map((l) => [l.key, l.pointCount]).sort()).toEqual(
      index.leaves.map((l) => [l.key, l.pointCount]).sort(),
    );
    expect(leaves.reduce((s, l) => s + l.pointCount, 0)).toBe(n);

    // A reader built from the parsed manifest and hierarchy alone knows the tree.
    const reader = new TileStoreReader(parseTileManifest(JSON.parse(manifestJson)), leaves);
    expect(reader.grid.depth).toBe(index.grid.depth);
    expect(reader.leaves().reduce((s, l) => s + l.pointCount, 0)).toBe(n);

    // Decoding one tile reproduces the points bucketed into it.
    const leaf = reader.leaves().find((l) => l.pointCount > 0)!;
    const points = reader.decodeTile(await store.read(leaf.key));
    expect(points.length).toBe(reader.pointCountOf(leaf.key));
    const cube = reader.cubeFor(leaf.key);
    let bad = 0;
    for (const pt of points) {
      for (let a = 0; a < 3; a++) {
        if (pt.position[a] < cube.min[a] || pt.position[a] > cube.min[a] + cube.size) bad++;
      }
      if (pt.classification !== 2 || pt.rgb?.[2] !== 9) bad++;
    }
    expect(bad).toBe(0);
  });

  it('fails closed on a corrupt manifest or hierarchy', () => {
    expect(() => parseTileManifest({ schemaVersion: 1, recordBytes: 30 })).toThrow();
    expect(() => parseTileManifest({ ...validManifest(), recordBytes: 19 })).toThrow(/does not match/);
    const { origin: _dropped, ...noOrigin } = validManifest() as { origin: unknown };
    expect(() => parseTileManifest(noOrigin)).toThrow(/origin/);
    expect(() => parseHierarchy('3 12\nnotaline\n')).toThrow();
    expect(() => parseHierarchy('8 5\n')).toThrow(/bad key/); // 8 is not an octant digit
  });

  it('refuses a manifest whose completeness invariants do not hold', () => {
    // Declared below loaded is impossible: a source cannot load more points than
    // it declared.
    expect(() =>
      parseTileManifest({ ...validManifest(), declaredPointCount: 4 }),
    ).toThrow(/declaredPointCount/);
    // A complete scan must have declared === loaded; a mismatch with the flag
    // still set is an inconsistent store.
    expect(() =>
      parseTileManifest({ ...validManifest(), complete: true, declaredPointCount: 12, pointCount: 10 }),
    ).toThrow(/complete is true/);
    // Degenerate geometry: min above max, or a non-positive root cube.
    expect(() =>
      parseTileManifest({ ...validManifest(), bounds: { min: [2, 0, 0], max: [1, 1, 1] } }),
    ).toThrow(/bounds\.min/);
    expect(() =>
      parseTileManifest({ ...validManifest(), root: { min: [0, 0, 0], size: 0 } }),
    ).toThrow(/root\.size must be positive/);
    // A truncated source round-trips: declared above loaded, complete false.
    const truncated = parseTileManifest({
      ...validManifest(),
      pointCount: 10,
      declaredPointCount: 25,
      complete: false,
    });
    expect(truncated.complete).toBe(false);
    expect(truncated.declaredPointCount).toBe(25);
  });

  it('refuses a hierarchy with a duplicate key, a bad sum, or an over-deep node', () => {
    const manifest = parseTileManifest({ ...validManifest(), pointCount: 10, depth: 2 });
    // A Map would silently collapse the duplicate and drop the second node's
    // points; the reader must refuse instead.
    expect(
      () => new TileStoreReader(manifest, [{ key: '0', pointCount: 5 }, { key: '0', pointCount: 5 }]),
    ).toThrow(/duplicate node key/);
    // Leaf counts that claim MORE points than the manifest declares — an
    // over-count is corruption. (An under-count is a tolerated hole, refused
    // elsewhere as an incompleteness, not here.)
    expect(
      () => new TileStoreReader(manifest, [{ key: '0', pointCount: 7 }, { key: '1', pointCount: 7 }]),
    ).toThrow(/more than/);
    // A hole (sum below the manifest total) is tolerated at this layer.
    expect(
      () => new TileStoreReader(manifest, [{ key: '0', pointCount: 4 }]),
    ).not.toThrow();
    // A node deeper than the declared octree depth.
    expect(
      () => new TileStoreReader(manifest, [{ key: '000', pointCount: 10 }]),
    ).toThrow(/deeper than the declared octree depth/);
    // A consistent hierarchy is accepted.
    expect(
      () => new TileStoreReader(manifest, [{ key: '0', pointCount: 4 }, { key: '1', pointCount: 6 }]),
    ).not.toThrow();
  });

  it('decodeTile refuses trailing bytes that do not complete a record', async () => {
    const n = 2000;
    const { index, store, schema, origin } = await buildIndex(n);
    const { manifestJson, hierarchy } = buildTileStore(index, schema, origin);
    const reader = new TileStoreReader(
      parseTileManifest(JSON.parse(manifestJson)),
      parseHierarchy(hierarchy),
    );
    const leaf = reader.leaves().find((l) => l.pointCount > 0)!;
    const bytes = await store.read(leaf.key);
    // Exact bytes decode.
    expect(reader.decodeTile(bytes).length).toBe(reader.pointCountOf(leaf.key));
    // One trailing byte makes it not a whole multiple of the record: refused,
    // rather than floored to a smaller "valid" tile.
    const overlong = new Uint8Array(bytes.byteLength + 1);
    overlong.set(bytes, 0);
    expect(() => reader.decodeTile(overlong)).toThrow(/truncated or corrupt/);
  });
});

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    pointCount: 10,
    recordBytes: 30,
    schema: { hasGps: true, hasRgb: true },
    origin: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    root: { min: [0, 0, 0], size: 1 },
    depth: 1,
    leafCount: 1,
  };
}
