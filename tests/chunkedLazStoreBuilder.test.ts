/**
 * chunkedLazStoreBuilder.test.ts — a chunked LAZ becomes a streamable store
 * out of core, the compressed sibling of tileStoreBuilder.test.ts.
 *
 * The committed multichunk.laz (written by the LAS writer, compressed by PDAL,
 * PDRF 7, 120 000 points across 3 real laszip chunks) is fed through
 * `buildTileStoreFromLaz`. The suite proves four things: the store conserves
 * every point; the build never reads the file whole, streaming a bounded window
 * of chunks instead; a LAZ the chunk table cannot address is refused by a named
 * error; and the store round-trips (artifacts reopen and every node decodes back
 * to the world coordinates it came from). A fifth test proves the one-pass fast
 * path (trusted header) is byte-identical to the two-pass path.
 *
 * The fixture is only ~291 KB, so the header/VLR/chunk-table scan — bounded by a
 * file-size-independent constant, not by the cloud — is a real fraction of it
 * only because the file is small. The point-data reads are what scale with the
 * cloud; those are what the instrumented assertion pins to a single chunk.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RangeSource, RangeSourceKind } from '../src/io/range/RangeSource';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { parseLasHeader } from '../src/io/lasHeader';
import { readLazChunkTable } from '../src/io/heavy/lazChunkTable';
import type { SpillStore } from '../src/io/heavy/oocIndexer';
import {
  buildTileStoreFromLaz,
  openTileStore,
  TILE_HIERARCHY_NAME,
  TILE_MANIFEST_NAME,
  type TileArtifactSink,
} from '../src/io/heavy/tileStoreBuilder';
import { ChunkedLazUnsupportedError } from '../src/io/heavy/chunkedLazSource';
import { OlvTileSource } from '../src/io/heavy/OlvTileSource';
import { TileChunkDecoder } from '../src/io/heavy/tileChunkDecoder';

function loadFixture(name: string): ArrayBuffer {
  const b = readFileSync(resolve(__dirname, 'fixtures', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** A RangeSource that records every read's [offset, length). */
function counting(inner: RangeSource): {
  range: RangeSource;
  reads: Array<{ offset: number; length: number }>;
} {
  const reads: Array<{ offset: number; length: number }> = [];
  const range: RangeSource = {
    id: () => inner.id(),
    kind: (): RangeSourceKind => inner.kind(),
    size: () => inner.size(),
    async readRange(offset, length, signal) {
      const buf = await inner.readRange(offset, length, signal);
      reads.push({ offset, length: buf.byteLength });
      return buf;
    },
  };
  return { range, reads };
}

function memorySpill(withClear = false): SpillStore {
  const parts = new Map<string, Uint8Array[]>();
  const store: SpillStore = {
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
  if (withClear) {
    (store as { clear?: () => Promise<void> }).clear = async () => {
      parts.clear();
    };
  }
  return store;
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

const FIXTURE = 'multichunk.laz';
const FIXTURE_POINTS = 120_000;

describe('chunked LAZ tile store builder', () => {
  it('builds a store that conserves every point and never reads the file whole', async () => {
    const buffer = loadFixture(FIXTURE);
    const fileBytes = buffer.byteLength;
    const header = parseLasHeader(buffer);
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buffer));
    expect(table.supported, 'fixture is a chunked LAZ').toBe(true);
    if (!table.supported) throw new Error('unreachable');
    // The fixture must genuinely span more than one chunk, or "windowed" is a lie.
    expect(table.chunks.length).toBeGreaterThan(1);
    const largestChunkBytes = Math.max(...table.chunks.map((c) => c.byteLength));

    const { range, reads } = counting(new ArrayBufferRangeSource(buffer));
    const spill = memorySpill();
    const built = await buildTileStoreFromLaz(range, spill, {
      pointsPerLeaf: 20_000,
      memoryBudgetBytes: 256 * 1024,
      // One chunk per read, so the largest point-data read is a single chunk.
      laz: { chunkWindow: 1 },
    });

    expect(built.reader.manifest.pointCount).toBe(FIXTURE_POINTS);
    expect(built.reader.leaves().reduce((s, l) => s + l.pointCount, 0)).toBe(FIXTURE_POINTS);

    // THE OUT-OF-CORE ASSERTION. No single read materialises the file, and the
    // reads that carry point data (offset at or past the point-data offset) are
    // each bounded by one chunk — they do not scale with the cloud. The one-time
    // header/VLR/chunk-table scan reads a small prefix bounded by the point-data
    // offset, never the whole file.
    expect(reads.length).toBeGreaterThan(table.chunks.length);
    const largest = Math.max(...reads.map((r) => r.length));
    expect(largest).toBeLessThan(fileBytes); // never the whole file in one read
    expect(largest).toBeLessThanOrEqual(largestChunkBytes);
    expect(largest).toBeLessThan(fileBytes / 2); // never even half of it

    const pointDataReads = reads.filter((r) => r.offset >= header.offsetToPointData);
    expect(Math.max(...pointDataReads.map((r) => r.length))).toBeLessThanOrEqual(largestChunkBytes);
    // Every header/VLR scan read (offset 0) is a small fixed prefix (the 8 KiB
    // header probe, or the offsetToPointData-bounded chunk-table head), a
    // constant that does not grow with the cloud.
    const scanReads = reads.filter((r) => r.offset < header.offsetToPointData);
    for (const r of scanReads) {
      expect(r.length).toBeLessThanOrEqual(8 * 1024);
    }
  });

  it('refuses a LAZ without a usable chunk table by a named error, not a whole read', async () => {
    // An uncompressed LAS has no laszip VLR: the chunk-table reader reports
    // unsupported, and the source throws rather than falling back to a whole read.
    const las = loadFixture('tiny.las');
    const { range, reads } = counting(new ArrayBufferRangeSource(las));
    await expect(buildTileStoreFromLaz(range, memorySpill())).rejects.toBeInstanceOf(
      ChunkedLazUnsupportedError,
    );
    // It gave up on the header/VLR scan; it never read the point body whole.
    const header = parseLasHeader(las);
    const bodyReads = reads.filter((r) => r.offset >= header.offsetToPointData && r.length > 64);
    expect(bodyReads.length).toBe(0);
  });

  it('refuses a chunked LAZ whose point format the chunk decoder does not support', async () => {
    // tiny-pdrf0.laz and tiny-pdrf1.laz have usable chunk tables but PDRF 0/1,
    // which the per-chunk decoder is not exercised for; the source names the
    // format in the error rather than decoding it wrong.
    for (const name of ['tiny-pdrf0.laz', 'tiny-pdrf1.laz']) {
      const buffer = loadFixture(name);
      const fmt = parseLasHeader(buffer).pointFormat;
      await expect(
        buildTileStoreFromLaz(new ArrayBufferRangeSource(buffer), memorySpill()),
      ).rejects.toThrow(
        new RegExp(`point format(s)?[^0-9]*${fmt}`),
      );
    }
  });

  it('round-trips: artifacts reopen and every node decodes to world coordinates', async () => {
    const buffer = loadFixture(FIXTURE);
    const header = parseLasHeader(buffer);
    const spill = memorySpill();
    const sink = memorySink();
    const built = await buildTileStoreFromLaz(new ArrayBufferRangeSource(buffer), spill, {
      pointsPerLeaf: 20_000,
      memoryBudgetBytes: 256 * 1024,
      sink,
    });

    expect([...sink.files.keys()].sort()).toEqual([TILE_HIERARCHY_NAME, TILE_MANIFEST_NAME]);
    const reopened = openTileStore(
      sink.files.get(TILE_MANIFEST_NAME)!,
      sink.files.get(TILE_HIERARCHY_NAME)!,
    );
    expect(reopened.manifest).toEqual(built.reader.manifest);

    const source = new OlvTileSource({
      id: 'laz-1',
      name: FIXTURE,
      store: built.reader,
      tiles: built.tiles,
    });
    const decoder = new TileChunkDecoder(built.reader.schema, built.reader.recordBytes);
    expect(source.octree.isComplete).toBe(true);
    expect(source.sourcePointCount).toBe(FIXTURE_POINTS);

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
          expect(world).toBeGreaterThanOrEqual(header.min[a] - 1);
          expect(world).toBeLessThanOrEqual(header.max[a] + 1);
        }
      }
      checked += decoded.pointCount;
    }
    expect(checked).toBe(FIXTURE_POINTS);
  });

  it('one-pass (trusted header) build is byte-identical to the two-pass build', async () => {
    const buffer = loadFixture(FIXTURE);
    const opts = { pointsPerLeaf: 20_000, memoryBudgetBytes: 256 * 1024 } as const;

    const fastSpill = memorySpill(true); // clear present -> one-pass eligible
    const fastCount = counting(new ArrayBufferRangeSource(buffer));
    const fast = await buildTileStoreFromLaz(fastCount.range, fastSpill, opts);

    const slowSpill = memorySpill(true);
    const slowCount = counting(new ArrayBufferRangeSource(buffer));
    const slow = await buildTileStoreFromLaz(slowCount.range, slowSpill, {
      ...opts,
      forceSlowPath: true,
    });

    // The trusted header is genuinely used: the one-pass build streams the
    // chunks once, the forced two-pass build streams them twice, so the fast
    // build issues strictly fewer point-data reads. If the header were rejected
    // both would take two passes and this would not hold.
    const bodyReads = (c: typeof fastCount) =>
      c.reads.filter((r) => r.offset >= parseLasHeader(buffer).offsetToPointData && r.length > 64)
        .length;
    expect(bodyReads(fastCount)).toBeLessThan(bodyReads(slowCount));

    expect(fast.manifestJson).toBe(slow.manifestJson);
    expect(fast.hierarchy).toBe(slow.hierarchy);
    for (const leaf of fast.reader.leaves()) {
      const a = await fast.tiles.read(leaf.key);
      const b = await slow.tiles.read(leaf.key);
      expect(a).toEqual(b);
    }
  });
});
