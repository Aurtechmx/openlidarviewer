/**
 * olvTileSource.test.ts — a built tile store presented as a StreamingSource.
 *
 * The adapter's job is to make a stored octree indistinguishable, to the
 * scheduler, from a COPC or EPT one. So the assertions here are about the
 * properties the scheduler actually depends on rather than about field shapes:
 * that the index really is a pyramid (interior nodes hold points AND children,
 * which is what lets a coarse view draw before the fine tiles arrive), that a
 * node's VoxelKey agrees with the octant path the ancestor walk derives by
 * shifting, that a node's declared bounds contain the points its tile decodes
 * to, and that the cube and the data extent stay separate figures.
 *
 * The bytes come from a memory store, so the whole path runs in Node.
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
import { TileChunkDecoder } from '../src/io/heavy/tileChunkDecoder';
import {
  OlvTileSource,
  tileKeyOf,
  tileNodeId,
  tileVoxelKey,
  type TileBytesReader,
} from '../src/io/heavy/OlvTileSource';

function memorySpill(): SpillStore & { readonly map: Map<string, Uint8Array[]> } {
  const parts = new Map<string, Uint8Array[]>();
  return {
    map: parts,
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

function cloud(n: number): GlobalPoints {
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
    // A deliberately shallow vertical span, so the cube and the data extent are
    // measurably different figures and a test can tell them apart.
    z[i] = 190 + (i % 7);
    intensity[i] = i & 0xffff;
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

async function buildReader(n: number) {
  const bytes = writeLas14(cloud(n));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const las = await openSlicedLasSource(new ArrayBufferRangeSource(ab));
  const spill = memorySpill();
  const index = await indexOutOfCore(las.source, spill, {
    pointsPerLeaf: 400,
    memoryBudgetBytes: 32 * 1024,
  });
  const { manifestJson, hierarchy } = buildTileStore(index, las.schema, las.origin);
  const reader = new TileStoreReader(
    parseTileManifest(JSON.parse(manifestJson)),
    parseHierarchy(hierarchy),
  );
  const tiles: TileBytesReader = { read: (key) => spill.read(key) };
  return { reader, tiles, spill, pointCount: n, origin: las.origin };
}

function makeSource(reader: TileStoreReader, tiles: TileBytesReader) {
  return new OlvTileSource({ id: 'tile-scan-1', name: 'field.las', store: reader, tiles });
}

describe('OlvTileSource', () => {
  it('presents the stored pyramid as a streaming octree', async () => {
    const { reader, tiles, pointCount } = await buildReader(5000);
    const source = makeSource(reader, tiles);

    expect(source.kind).toBe('tiles');
    expect(source.sourcePointCount).toBe(pointCount);
    expect(source.octree.isComplete).toBe(true);
    expect(source.octree.errors).toEqual([]);

    const nodes = source.octree.nodes();
    expect(nodes.length).toBe(reader.leaves().length);
    expect(nodes.reduce((s, n) => s + n.record.pointCount, 0)).toBe(pointCount);

    // The pyramid property: at least one node holds points AND has children.
    // Without it there is nothing coarse to draw, and showing the whole scan
    // would mean loading the whole scan.
    const interior = nodes.filter((n) => n.record.pointCount > 0 && n.childIds.length > 0);
    expect(interior.length).toBeGreaterThan(0);
    expect(source.maxDepth()).toBeGreaterThan(0);

    // Every non-root node's parent is present and lists it as a child.
    for (const node of nodes) {
      const parentId = node.record.parentId;
      if (parentId === undefined) {
        expect(node.record.key.depth).toBe(0);
        continue;
      }
      const parent = source.octree.store.get(parentId);
      expect(parent, `missing parent for ${node.record.id}`).toBeDefined();
      expect(parent!.childIds).toContain(node.record.id);
    }
  });

  it('derives a VoxelKey the ancestor walk can shift back to the parent path', async () => {
    const { reader, tiles } = await buildReader(5000);
    const source = makeSource(reader, tiles);

    for (const node of source.octree.nodes()) {
      const key = tileKeyOf(node.record.id);
      expect(tileNodeId(key)).toBe(node.record.id);
      expect(node.record.key).toEqual(tileVoxelKey(key));
      // This is exactly what StreamingScheduler.buildAncestorProtection does:
      // one right-shift per level must land on the prefix path's own key.
      let { x, y, z } = node.record.key;
      for (let d = node.record.key.depth - 1; d >= 0; d--) {
        x >>= 1;
        y >>= 1;
        z >>= 1;
        expect({ depth: d, x, y, z }).toEqual(tileVoxelKey(key.slice(0, d)));
      }
    }
  });

  it('keeps the octree cube and the data extent as separate figures', async () => {
    const { reader, tiles } = await buildReader(5000);
    const source = makeSource(reader, tiles);

    const cube = source.localBounds();
    const data = source.dataBounds();
    const side = (b: readonly number[], a: number) => b[a + 3] - b[a];
    expect(side(cube, 0)).toBeCloseTo(side(cube, 1), 9);
    expect(side(cube, 0)).toBeCloseTo(side(cube, 2), 9);
    // The scan is 6 m tall inside a cube hundreds of metres on a side, so a
    // consumer that read the cube as the extent would over-report height badly.
    expect(side(data, 2)).toBeLessThan(side(cube, 2) / 10);
    for (let a = 0; a < 3; a++) {
      expect(data[a]).toBeGreaterThanOrEqual(cube[a] - 1e-6);
      expect(data[a + 3]).toBeLessThanOrEqual(cube[a + 3] + 1e-6);
    }
  });

  it('reads and decodes a node chunk into the points its bounds claim', async () => {
    const { reader, tiles } = await buildReader(5000);
    const source = makeSource(reader, tiles);
    const decoder = new TileChunkDecoder(reader.schema, reader.recordBytes);

    const node = source.octree.nodes().find((n) => n.record.pointCount > 0)!;
    const chunk = await source.readNodeChunk(node.record);
    // An owned buffer, not a view into the store's bytes: the scheduler
    // transfers it to a worker.
    expect(chunk.byteLength).toBe(node.record.pointCount * reader.recordBytes);

    const meta = source.decodeMeta(node.record);
    expect(meta.pointCount).toBe(node.record.pointCount);
    expect(meta.pointRecordLength).toBe(reader.recordBytes);

    const decoded = await decoder.decode(chunk, meta);
    expect(decoded.pointCount).toBe(node.record.pointCount);
    let outside = 0;
    for (let i = 0; i < decoded.pointCount; i++) {
      for (let a = 0; a < 3; a++) {
        const v = decoded.positions[i * 3 + a];
        if (v < node.record.bounds[a] || v > node.record.bounds[a + 3]) outside++;
      }
    }
    expect(outside).toBe(0);
    expect(decoded.classification[0]).toBe(2);
    expect(decoded.rgb?.[2]).toBe(9);
  });

  it('recovers world coordinates by adding the render origin back', async () => {
    const { reader, tiles, origin } = await buildReader(5000);
    const source = makeSource(reader, tiles);
    const decoder = new TileChunkDecoder(reader.schema, reader.recordBytes);

    expect(source.renderOrigin).toEqual(origin);
    // The build already recentred, so the decoder must not shift again.
    const node = source.octree.nodes().find((n) => n.record.pointCount > 0)!;
    const meta = source.decodeMeta(node.record);
    expect(meta.renderOrigin).toEqual([0, 0, 0]);
    expect(meta.scale).toEqual([1, 1, 1]);
    expect(meta.offset).toEqual([0, 0, 0]);

    // The synthetic cloud spans x 500000..500237, y 4100000..4100186, z 190..196.
    const worldMin = [500000, 4100000, 190];
    const worldMax = [500237, 4100189, 196];
    const decoded = await decoder.decode(await source.readNodeChunk(node.record), meta);
    let outside = 0;
    let wouldBeOutsideUnshifted = 0;
    for (let i = 0; i < decoded.pointCount; i++) {
      for (let a = 0; a < 3; a++) {
        const local = decoded.positions[i * 3 + a];
        const world = local + source.renderOrigin[a];
        if (world < worldMin[a] - 1 || world > worldMax[a] + 1) outside++;
        if (local < worldMin[a] - 1 || local > worldMax[a] + 1) wouldBeOutsideUnshifted++;
      }
    }
    expect(outside).toBe(0);
    // The shift is load-bearing on this fixture, so the assertion above is real.
    expect(wouldBeOutsideUnshifted).toBeGreaterThan(0);
  });

  it('reports colour modes from the stored schema and no CRS unless given one', async () => {
    const { reader, tiles } = await buildReader(2000);
    const withRgb = makeSource(reader, tiles);
    expect(withRgb.defaultColorMode()).toBe('rgb');
    expect(withRgb.availableColorModes()).toContain('rgb');
    expect(withRgb.crs()).toBeNull();

    const colourless = new TileStoreReader(
      { ...reader.manifest, schema: { hasGps: reader.schema.hasGps, hasRgb: false } },
      reader.leaves(),
    );
    const mono = new OlvTileSource({ id: 'x', name: 'y', store: colourless, tiles });
    expect(mono.defaultColorMode()).toBe('elevation');
    expect(mono.availableColorModes()).not.toContain('rgb');
    expect(mono.decodeMeta(mono.octree.nodes()[0].record).rgbEightBit).toBeUndefined();
  });

  it('refuses to claim completeness when the hierarchy has a hole', async () => {
    const { reader, tiles } = await buildReader(5000);
    const full = reader.leaves();
    const orphan = full.find((l) => l.key.length >= 2)!;
    const holed = new TileStoreReader(
      reader.manifest,
      full.filter((l) => l.key !== orphan.key.slice(0, -1)),
    );
    const source = new OlvTileSource({ id: 'x', name: 'y', store: holed, tiles });

    expect(source.octree.isComplete).toBe(false);
    expect(source.octree.errors.join(' ')).toContain(orphan.key.slice(0, -1));
    // The orphan's own points are still offered — dropping the node would lose
    // them on top of losing the parent.
    expect(source.octree.store.get(tileNodeId(orphan.key))).toBeDefined();
  });
});
