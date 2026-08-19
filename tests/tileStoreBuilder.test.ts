/**
 * tileStoreBuilder.test.ts — a LAS file becomes a streamable store in one call.
 *
 * The build is covered as a loop: the artifacts it writes are the artifacts a
 * later session reopens, the store that comes back describes the same tree, and
 * the points a node yields land back on the world coordinates the file started
 * with once the render origin is added. Peak staging memory is asserted against
 * the budget, since staying under it is what the out-of-core path is for.
 */
import { describe, it, expect } from 'vitest';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { SpillStore } from '../src/io/heavy/oocIndexer';
import {
  buildTileStoreFromLas,
  openTileStore,
  TILE_HIERARCHY_NAME,
  TILE_MANIFEST_NAME,
  type TileArtifactSink,
} from '../src/io/heavy/tileStoreBuilder';
import { OlvTileSource } from '../src/io/heavy/OlvTileSource';
import { TileChunkDecoder } from '../src/io/heavy/tileChunkDecoder';

function memorySpill(): SpillStore {
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

function memorySink(): TileArtifactSink & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async write(name, text) {
      files.set(name, text);
    },
  };
}

const WORLD_MIN = [400000, 5200000, 55] as const;

function lasBytes(n: number): ArrayBuffer {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = WORLD_MIN[0] + (i % 100) * 2;
    y[i] = WORLD_MIN[1] + Math.floor(i / 100) * 2;
    z[i] = WORLD_MIN[2] + (i % 11) * 0.5;
    intensity[i] = i & 0xffff;
    classification[i] = 2;
  }
  const cloud: GlobalPoints = { count: n, x, y, z, intensity, classification };
  const bytes = writeLas14(cloud);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('tile store builder', () => {
  it('builds a store whose artifacts reopen to the same tree', async () => {
    const n = 6000;
    const spill = memorySpill();
    const sink = memorySink();
    const budget = 64 * 1024;
    const built = await buildTileStoreFromLas(new ArrayBufferRangeSource(lasBytes(n)), spill, {
      pointsPerLeaf: 400,
      memoryBudgetBytes: budget,
      sink,
    });

    expect(built.reader.manifest.pointCount).toBe(n);
    expect(built.reader.leaves().reduce((s, l) => s + l.pointCount, 0)).toBe(n);
    // The point of reading out of core: staging stays near the budget rather
    // than growing with the file.
    expect(built.peakBufferedBytes).toBeLessThanOrEqual(budget + built.reader.recordBytes);

    // The artifacts written are the artifacts a later session reopens.
    expect([...sink.files.keys()].sort()).toEqual([TILE_HIERARCHY_NAME, TILE_MANIFEST_NAME]);
    const reopened = openTileStore(
      sink.files.get(TILE_MANIFEST_NAME)!,
      sink.files.get(TILE_HIERARCHY_NAME)!,
    );
    expect(reopened.manifest).toEqual(built.reader.manifest);
    expect(reopened.leaves().sort((a, b) => (a.key < b.key ? -1 : 1))).toEqual(
      built.reader.leaves().sort((a, b) => (a.key < b.key ? -1 : 1)),
    );
  });

  it('streams the built store back to the world coordinates it came from', async () => {
    const n = 6000;
    const spill = memorySpill();
    const built = await buildTileStoreFromLas(new ArrayBufferRangeSource(lasBytes(n)), spill, {
      pointsPerLeaf: 400,
      memoryBudgetBytes: 64 * 1024,
    });
    const source = new OlvTileSource({
      id: 'built-1',
      name: 'plain.las',
      store: built.reader,
      tiles: built.tiles,
    });
    const decoder = new TileChunkDecoder(built.reader.schema, built.reader.recordBytes);

    expect(source.octree.isComplete).toBe(true);
    expect(source.sourcePointCount).toBe(n);

    // Every node, not just one: a frame mistake usually shows on the nodes the
    // spot check misses.
    let checked = 0;
    for (const node of source.octree.nodes()) {
      if (node.record.pointCount === 0) continue;
      const decoded = await decoder.decode(
        await source.readNodeChunk(node.record),
        source.decodeMeta(node.record),
      );
      for (let i = 0; i < decoded.pointCount; i++) {
        for (let a = 0; a < 3; a++) {
          const world = decoded.positions[i * 3 + a] + source.renderOrigin[a];
          expect(world).toBeGreaterThanOrEqual(WORLD_MIN[a] - 1);
        }
      }
      checked += decoded.pointCount;
    }
    expect(checked).toBe(n);
  });

  it('fails closed when an artifact is damaged', async () => {
    const spill = memorySpill();
    const sink = memorySink();
    await buildTileStoreFromLas(new ArrayBufferRangeSource(lasBytes(1200)), spill, {
      pointsPerLeaf: 300,
      sink,
    });
    const manifest = sink.files.get(TILE_MANIFEST_NAME)!;
    const hierarchy = sink.files.get(TILE_HIERARCHY_NAME)!;

    expect(() => openTileStore(manifest.replace(/"origin"/, '"orgin"'), hierarchy)).toThrow(/origin/);
    expect(() => openTileStore(manifest, '3 notanumber\n')).toThrow();
  });
});
