/**
 * heavyByteBudgetMemory.test.ts — adversarial large-file memory suite for the
 * shared decoded-byte budget ({@link src/io/heavy/heavyByteBudget.ts}).
 *
 * Each case is a metadata-only or fake-range fixture — no real gigabyte file —
 * that would, without the budget, force one enormous allocation or range read
 * BEFORE the out-of-core spill can protect memory, because the size is bounded
 * by a point count or a structure count but never by decoded/compressed BYTES at
 * the real record length. The invariant every case asserts is the same: NO
 * allocation or read request larger than the configured budget is attempted
 * before the refusal. Refusals take the reader's own fail-closed shape
 * (`supported: false`, a typed throw) and never fall back to a whole-file path.
 */
import { describe, it, expect } from 'vitest';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { RangeSource } from '../src/io/range/RangeSource';
import { ArithmeticEncoder, IntegerCompressorEnc } from '../src/io/heavy/arithmeticCoder';
import {
  MAX_DECODED_ALLOCATION_BYTES,
  MAX_BATCH_SOURCE_BYTES,
  MAX_CHUNK_TABLE_ENTRIES,
  MAX_TILE_BYTES,
  batchPointsForRecordLength,
  withinDecodedByteBudget,
} from '../src/io/heavy/heavyByteBudget';
import { readLazChunkTable, type LazChunkRange } from '../src/io/heavy/lazChunkTable';
import { planChunkWindow } from '../src/io/heavy/chunkedLazSource';
import { openSlicedLas } from '../src/io/heavy/slicedLasReader';
import { indexOutOfCore, DegenerateCloudError, type PointSource, type SpillStore } from '../src/io/heavy/oocIndexer';
import { decodeTile, tileRecordBytes, TileTruncationError, type TileSchema } from '../src/io/heavy/tileRecord';
import { decompressChunk, type LazPerfModule } from '../src/io/copc/copcChunkDecompress';
import { buildTileStoreFromLas } from '../src/io/heavy/tileStoreBuilder';

/** An in-memory {@link SpillStore}: append concatenates per key, read joins. */
function memoryStore(): SpillStore {
  const tiles = new Map<string, Uint8Array[]>();
  return {
    async append(key, bytes) {
      const parts = tiles.get(key) ?? [];
      parts.push(bytes.slice());
      tiles.set(key, parts);
    },
    async read(key) {
      const parts = tiles.get(key) ?? [];
      const total = parts.reduce((a, p) => a + p.byteLength, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.byteLength;
      }
      return out;
    },
    async keys() {
      return [...tiles.keys()];
    },
    async clear() {
      tiles.clear();
    },
  };
}

// --- instrumentation --------------------------------------------------------

/** A RangeSource that records the largest single read requested against it. */
class WatchedRangeSource implements RangeSource {
  maxRead = 0;
  private readonly inner: RangeSource;
  constructor(inner: RangeSource) {
    this.inner = inner;
  }
  id(): string {
    return this.inner.id();
  }
  kind(): ReturnType<RangeSource['kind']> {
    return this.inner.kind();
  }
  size(): Promise<number> {
    return this.inner.size();
  }
  readRange(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (length > this.maxRead) this.maxRead = length;
    return this.inner.readRange(offset, length, signal);
  }
}

// --- LAZ fixture (shared shape with lazChunkBoundedDecode.test.ts) ----------

const LAZ_HEADER_SIZE = 227;
const VLR_HEADER = 54;
const LASZIP_PAYLOAD = 34;

interface LazSpec {
  compressor: number;
  chunkSize: number;
  pointCount: number;
  chunkByteSizes: number[];
  chunkPointCounts?: number[];
  physicalGap?: number;
  recordLength?: number;
  pointFormat?: number;
}

function buildLazFixture(spec: LazSpec): ArrayBuffer {
  const offsetToPointData = LAZ_HEADER_SIZE + VLR_HEADER + LASZIP_PAYLOAD;
  const chunksStart = offsetToPointData + 8;
  const chunkBytesTotal = spec.physicalGap ?? spec.chunkByteSizes.reduce((a, b) => a + b, 0);
  const tableOffset = chunksStart + chunkBytesTotal;

  const enc = new ArithmeticEncoder();
  const ic = new IntegerCompressorEnc(enc, 2);
  let prevCount = 0;
  let prevStart = 0;
  for (let i = 0; i < spec.chunkByteSizes.length; i++) {
    if (spec.chunkPointCounts) {
      ic.compress(prevCount | 0, spec.chunkPointCounts[i] | 0, 0);
      prevCount = spec.chunkPointCounts[i];
    }
    ic.compress(prevStart | 0, spec.chunkByteSizes[i] | 0, 1);
    prevStart = spec.chunkByteSizes[i];
  }
  const tableBody = enc.done();

  const total = tableOffset + 8 + tableBody.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  u8.set([0x4c, 0x41, 0x53, 0x46], 0); // 'LASF'
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, LAZ_HEADER_SIZE, true);
  view.setUint32(96, offsetToPointData, true);
  view.setUint32(100, 1, true);
  view.setUint8(104, 0x80 | (spec.pointFormat ?? 0));
  view.setUint16(105, spec.recordLength ?? 20, true);
  view.setUint32(107, spec.pointCount, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(131 + axis * 8, 0.001, true);
    view.setFloat64(155 + axis * 8, 0, true);
  }
  for (let i = 0; i < 6; i++) view.setFloat64(179 + i * 8, i % 2 === 0 ? 100 : 0, true);

  let c = LAZ_HEADER_SIZE;
  view.setUint16(c, 0, true);
  const userId = 'laszip encoded';
  for (let i = 0; i < userId.length; i++) view.setUint8(c + 2 + i, userId.charCodeAt(i));
  view.setUint16(c + 18, 22204, true);
  view.setUint16(c + 20, LASZIP_PAYLOAD, true);
  c += VLR_HEADER;
  view.setUint16(c, spec.compressor, true);
  view.setUint16(c + 2, 0, true);
  view.setUint8(c + 4, 2);
  view.setUint8(c + 5, 4);
  view.setUint16(c + 6, 0, true);
  view.setUint32(c + 8, 0, true);
  view.setUint32(c + 12, spec.chunkSize, true);

  view.setBigInt64(offsetToPointData, BigInt(tableOffset), true);
  for (let i = chunksStart; i < tableOffset; i++) u8[i] = i & 0xff;

  view.setUint32(tableOffset, 0, true);
  view.setUint32(tableOffset + 4, spec.chunkByteSizes.length, true);
  u8.set(tableBody, tableOffset + 8);
  return buf;
}

// --- LAS fixture (uncompressed, with a controllable record length) ----------

const LAS_HEADER_SIZE = 227;

/** A minimal valid uncompressed LAS with `physicalPoints` records of zero bytes. */
function buildLasFixture(opts: {
  pointFormat: number;
  recordLength: number;
  declaredPointCount: number;
  physicalPoints: number;
}): ArrayBuffer {
  const offsetToPointData = LAS_HEADER_SIZE;
  const total = offsetToPointData + opts.physicalPoints * opts.recordLength;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x4c, 0x41, 0x53, 0x46], 0); // 'LASF'
  view.setUint8(24, 1);
  view.setUint8(25, 2); // version 1.2 → legacy uint32 count
  view.setUint16(94, LAS_HEADER_SIZE, true);
  view.setUint32(96, offsetToPointData, true);
  view.setUint32(100, 0, true); // no VLRs
  view.setUint8(104, opts.pointFormat);
  view.setUint16(105, opts.recordLength, true);
  view.setUint32(107, opts.declaredPointCount, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(131 + axis * 8, 0.001, true); // scale > 0
    view.setFloat64(155 + axis * 8, 0, true); // offset
  }
  // max=100, min=0 on each axis (non-degenerate box)
  view.setFloat64(179, 100, true); view.setFloat64(187, 0, true);
  view.setFloat64(195, 100, true); view.setFloat64(203, 0, true);
  view.setFloat64(211, 100, true); view.setFloat64(219, 0, true);
  return buf;
}

const src = (buf: ArrayBuffer) => new ArrayBufferRangeSource(buf, 'fixture');

// --- fake laz-perf for the COPC node case -----------------------------------

/** Records whether any WASM allocation was attempted, so the test can prove the
 *  budget refusal happens BEFORE laz-perf is touched. */
function watchedLazPerf(): { module: LazPerfModule; mallocs: number[] } {
  const mallocs: number[] = [];
  const module = {
    _malloc: (n: number) => {
      mallocs.push(n);
      return 1;
    },
    _free: () => {},
    HEAPU8: new Uint8Array(16),
    ChunkDecoder: class {
      open(): void {}
      getPoint(): void {}
      delete(): void {}
    },
  } as unknown as LazPerfModule;
  return { module, mallocs };
}

describe('heavyByteBudget — adversarial large-file memory suite', () => {
  it('LAZ chunk claiming a huge point count is refused before allocation', async () => {
    const range = new WatchedRangeSource(
      src(
        buildLazFixture({
          compressor: 3,
          chunkSize: 0xffffffff,
          pointCount: 500_000_000,
          chunkByteSizes: [5000],
          chunkPointCounts: [500_000_000],
        }),
      ),
    );
    const t = await readLazChunkTable(range);
    expect(t.supported).toBe(false);
    // Refused on metadata alone: the largest read stayed tiny, no chunk payload
    // and no `points × record` buffer was ever fetched or built.
    expect(range.maxRead).toBeLessThan(64 * 1024);
  });

  it('LAZ chunk with a huge record length is refused on decoded bytes', async () => {
    // A modest point count (under the point cap) but a 65535-byte record: the
    // point cap alone would admit it, the decoded-byte cap refuses it.
    const points = 100_000;
    expect(withinDecodedByteBudget(points, 65535)).toBe(false);
    const t = await readLazChunkTable(
      src(
        buildLazFixture({
          compressor: 3,
          chunkSize: 0xffffffff,
          pointCount: points,
          chunkByteSizes: [5000],
          chunkPointCounts: [points],
          recordLength: 65535,
          pointFormat: 7,
        }),
      ),
    );
    expect(t.supported).toBe(false);
    if (!t.supported) expect(t.reason).toContain('decode budget');
  });

  it('a 16M-chunk table is refused before the delta arrays are allocated', async () => {
    const numChunks = 16_777_216;
    expect(numChunks).toBeGreaterThan(MAX_CHUNK_TABLE_ENTRIES);
    // Only the table head (8 bytes: version + count) needs to be present; the
    // refusal fires on the count before any body read or Float64Array(numChunks).
    const range = new WatchedRangeSource(
      src(
        buildLazFixture({
          compressor: 2,
          chunkSize: 250,
          pointCount: 250,
          chunkByteSizes: [64],
          physicalGap: 64,
        }),
      ),
    );
    // Rewrite the declared chunk count in the fixture's table head to 16M.
    const buf = await range.readRange(0, await range.size());
    const view = new DataView(buf);
    // Locate the table offset field and patch numChunks at tableOffset+4.
    const offsetToPointData = LAZ_HEADER_SIZE + VLR_HEADER + LASZIP_PAYLOAD;
    const tableOffset = Number(view.getBigInt64(offsetToPointData, true));
    view.setUint32(tableOffset + 4, numChunks, true);
    const patched = new WatchedRangeSource(src(buf));
    const t = await readLazChunkTable(patched);
    expect(t.supported).toBe(false);
    if (!t.supported) expect(t.reason).toContain('sanity cap');
    // The delta-array staging (numChunks × 16 bytes ≈ 256 MiB) was never read or
    // allocated: no read approached even a megabyte.
    expect(patched.maxRead).toBeLessThan(1024 * 1024);
  });

  it('four individually-valid chunks whose window decoded bytes exceed budget shrink the window', () => {
    // Each chunk is a legal, sub-budget decode; four of them together are not.
    const recordLength = 1000;
    const perChunkPoints = Math.floor((MAX_DECODED_ALLOCATION_BYTES / recordLength) * 0.4);
    expect(withinDecodedByteBudget(perChunkPoints, recordLength)).toBe(true);
    const chunks: LazChunkRange[] = [];
    let off = 0;
    for (let i = 0; i < 4; i++) {
      chunks.push({ byteOffset: off, byteLength: 1000, pointCount: perChunkPoints, firstPointIndex: i * perChunkPoints });
      off += 1000;
    }
    // Without the decoded cap a window of 4 would stage 1.6× the budget at once;
    // the planner takes at most 2 (0.4 + 0.4 = 0.8 ≤ 1, a third would be 1.2 > 1).
    const plan = planChunkWindow(chunks, 0, 4, recordLength);
    expect(plan.end).toBe(2);
    // The aggregate decoded bytes of the taken window stay within budget.
    const takenPoints = perChunkPoints * plan.end;
    expect(withinDecodedByteBudget(takenPoints, recordLength)).toBe(true);
  });

  it('LAS record length 4096 and 65535 keep one batch read within the source ceiling', async () => {
    for (const recordLength of [4096, 65535]) {
      const range = new WatchedRangeSource(
        src(buildLasFixture({ pointFormat: 0, recordLength, declaredPointCount: 5000, physicalPoints: 5000 })),
      );
      const opened = await openSlicedLas(range);
      const iter = opened.batches();
      await iter.next(); // read exactly one batch
      expect(range.maxRead).toBeLessThanOrEqual(MAX_BATCH_SOURCE_BYTES);
      expect(range.maxRead).toBeGreaterThan(0);
      // Batch is at least one point and never reads over 16 MiB at this record.
      expect(batchPointsForRecordLength(recordLength, 262_144)).toBeGreaterThanOrEqual(1);
      expect(batchPointsForRecordLength(recordLength, 262_144) * recordLength).toBeLessThanOrEqual(
        MAX_BATCH_SOURCE_BYTES,
      );
    }
  });

  it('100M identical XYZ collapsing to one logical tile fails closed as degenerate', async () => {
    // The whole cloud shares one XYZ, so every point lands in one leaf key and one
    // LOD-hash bucket — no depth subdivides it. A tiny tile budget makes the
    // refusal cheap to prove without materialising 100M points.
    const recordBytes = 12;
    const perBatch = 1000;
    const batches = 50; // 50k identical points
    const source: PointSource = {
      async *batches() {
        for (let b = 0; b < batches; b++) {
          const positions = new Float32Array(perBatch * 3); // all zero → identical XYZ
          yield { positions, count: perBatch };
        }
      },
    };
    const store = memoryStore();
    // maxTileBytes admits only ~2000 points at 12 bytes; the pile blows past it.
    const maxTileBytes = 2000 * recordBytes;
    await expect(
      indexOutOfCore(source, store, { maxTileBytes, memoryBudgetBytes: 1 << 20 }),
    ).rejects.toBeInstanceOf(DegenerateCloudError);
    // No spilled tile ever exceeded the budget: the build refused rather than
    // producing an oversized tile.
    for (const key of await store.keys()) {
      const bytes = await store.read(key);
      expect(bytes.byteLength).toBeLessThanOrEqual(maxTileBytes);
    }
  });

  it('COPC node with a low point count but a huge record length is refused before allocation', () => {
    const { module, mallocs } = watchedLazPerf();
    // A point count far under MAX_NODE_POINTS (50M), so the point cap admits it,
    // but a 65535-byte record makes the decoded size ≈ 197 MB, over budget.
    const overPoints = 3000;
    const recordLength = 65535;
    expect(overPoints * recordLength).toBeGreaterThan(MAX_DECODED_ALLOCATION_BYTES);
    expect(withinDecodedByteBudget(overPoints, recordLength, MAX_DECODED_ALLOCATION_BYTES)).toBe(false);
    // Give the guard a plausible compressed size so the count passes the count/byte
    // validators and only the decoded-byte cap can refuse it.
    const chunk = new ArrayBuffer(overPoints * recordLength);
    expect(() =>
      decompressChunk(module, chunk, {
        pointDataRecordFormat: 7,
        pointRecordLength: recordLength,
        pointCount: overPoints,
        scale: [1, 1, 1],
        offset: [0, 0, 0],
        renderOrigin: [0, 0, 0],
      }),
    ).toThrow(/decode budget/);
    // The refusal happened before any WASM allocation.
    expect(mallocs).toHaveLength(0);
  });

  it('a truncated tile is refused, never decoded as a sparse tile', () => {
    const schema: TileSchema = { hasGps: false, hasRgb: false };
    const recordBytes = tileRecordBytes(schema);
    const full = new Uint8Array(10 * recordBytes);
    // The hierarchy declares 10 points; only 5 records are present.
    const half = full.subarray(0, 5 * recordBytes);
    expect(() => decodeTile(half, schema, recordBytes, 10)).toThrow(TileTruncationError);
    // An exact tile still decodes.
    const exact = decodeTile(full, schema, recordBytes, 10);
    expect(exact.pointCount).toBe(10);
  });

  it('a truncated source LAS carries declared-vs-loaded honesty to the manifest', async () => {
    const declared = 10_000;
    const physical = 4_000; // file physically holds fewer points than it declares
    const range = src(buildLasFixture({ pointFormat: 0, recordLength: 20, declaredPointCount: declared, physicalPoints: physical }));
    const opened = await openSlicedLas(range);
    expect(opened.declaredPointCount).toBe(declared);
    expect(opened.readablePointCount).toBe(physical);
    expect(opened.complete).toBe(false);

    const store = memoryStore();
    const built = await buildTileStoreFromLas(range, store);
    expect(built.reader.manifest.complete).toBe(false);
    expect(built.reader.manifest.declaredPointCount).toBe(declared);
    // The loaded count is the physical count, never the declared one — a truncated
    // scan is not presented as a complete smaller scan.
    expect(built.reader.manifest.pointCount).toBe(physical);
    expect(built.reader.manifest.pointCount).toBeLessThan(built.reader.manifest.declaredPointCount!);
  });

  it('the tile budget constant bounds a leaf the reader would load whole', () => {
    // Sanity: MAX_TILE_BYTES is the ceiling the degenerate guard enforces.
    expect(MAX_TILE_BYTES).toBeGreaterThan(0);
    expect(withinDecodedByteBudget(1, MAX_TILE_BYTES + 1, MAX_TILE_BYTES)).toBe(false);
  });
});
