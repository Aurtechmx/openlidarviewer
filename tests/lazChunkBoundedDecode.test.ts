/**
 * lazChunkBoundedDecode.test.ts — the bounded-decode caps that keep a hostile
 * chunked LAZ from OOMing the worker before the out-of-core spill can protect
 * anything.
 *
 * A LAZ chunk table can be valid yet pathological: a multi-gigabyte file may
 * declare a few enormous chunks, each of which the out-of-core path would decode
 * WHOLE (a per-chunk range read plus a `points * record` allocation). These
 * cases pin the refusal:
 *
 *  1. a chunk over the per-chunk point cap → `readLazChunkTable` reports
 *     `supported: false`, never a usable table;
 *  2. a chunk over the per-chunk compressed-byte cap → same;
 *  3. `executeHeavyLasBuild` turns that unsupported table into a `heavy: true`
 *     refusal with COPC/EPT guidance, without allocating the huge array or
 *     touching OPFS;
 *  4. `planChunkWindow` shrinks a window whose contiguous span would exceed the
 *     window-span cap, so a wide window of legal-but-large chunks never issues an
 *     unbounded `readRange` — while a normal run of small chunks is left whole;
 *  5. regression — the committed multichunk fixture (~50k-point chunks) is still
 *     supported and still decodes, so the caps only bite the pathological file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { RangeSource } from '../src/io/range/RangeSource';
import { ArithmeticEncoder, IntegerCompressorEnc } from '../src/io/heavy/arithmeticCoder';
import {
  readLazChunkTable,
  MAX_LAZ_CHUNK_POINTS,
  MAX_LAZ_CHUNK_COMPRESSED_BYTES,
  type LazChunkRange,
} from '../src/io/heavy/lazChunkTable';
import {
  openChunkedLazSource,
  planChunkWindow,
  MAX_LAZ_WINDOW_SPAN_BYTES,
} from '../src/io/heavy/chunkedLazSource';
import { executeHeavyLasBuild } from '../src/app/heavyLasExecutor';
import type {
  HeavyLasBridgeDeps,
  HeavyLasBridgeEnv,
  LasHeaderFacts,
} from '../src/app/heavyLasTypes';

const HEADER_SIZE = 227; // LAS 1.2
const VLR_HEADER = 54;
const LASZIP_PAYLOAD = 34;

interface FixtureSpec {
  compressor: number;
  chunkSize: number;
  pointCount: number;
  chunkByteSizes: number[];
  chunkPointCounts?: number[];
  /**
   * Physical gap between the first chunk and the table, when it must differ from
   * the sum of the ENCODED byte sizes. `readLazChunkTable` never reads chunk
   * payloads, so a fixture can encode a huge byte-length delta (to trip the
   * compressed-byte cap) while keeping the file small.
   */
  physicalGap?: number;
}

/** A synthetic LAZ: real LAS header + laszip VLR + filler chunk bytes + a table
 *  encoded by the mirror encoder. Shared shape with chunkedLazStoreBuilder. */
function buildLazFixture(spec: FixtureSpec): ArrayBuffer {
  const offsetToPointData = HEADER_SIZE + VLR_HEADER + LASZIP_PAYLOAD;
  const chunksStart = offsetToPointData + 8;
  const chunkBytesTotal =
    spec.physicalGap ?? spec.chunkByteSizes.reduce((a, b) => a + b, 0);
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
  view.setUint16(94, HEADER_SIZE, true);
  view.setUint32(96, offsetToPointData, true);
  view.setUint32(100, 1, true);
  view.setUint8(104, 0x80 | 0);
  view.setUint16(105, 20, true);
  view.setUint32(107, spec.pointCount, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(131 + axis * 8, 0.001, true);
    view.setFloat64(155 + axis * 8, 0, true);
  }
  for (let i = 0; i < 6; i++) view.setFloat64(179 + i * 8, i % 2 === 0 ? 100 : 0, true);

  let c = HEADER_SIZE;
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

const src = (buf: ArrayBuffer) => new ArrayBufferRangeSource(buf, 'fixture.laz');

/** A fake chunk range with only the fields `planChunkWindow` reads. */
function chunk(byteOffset: number, byteLength: number): LazChunkRange {
  return { byteOffset, byteLength, pointCount: 1, firstPointIndex: 0 };
}

describe('readLazChunkTable — bounded-decode caps', () => {
  it('refuses a chunk whose decoded point count is over the cap', async () => {
    const points = MAX_LAZ_CHUNK_POINTS + 1;
    const t = await readLazChunkTable(
      src(
        buildLazFixture({
          compressor: 3,
          chunkSize: 0xffffffff,
          pointCount: points,
          chunkByteSizes: [5000],
          chunkPointCounts: [points],
        }),
      ),
    );
    expect(t.supported).toBe(false);
    if (!t.supported) expect(t.reason).toContain('too large for bounded browser');
  });

  it('refuses a chunk whose compressed span is over the cap', async () => {
    const bytes = MAX_LAZ_CHUNK_COMPRESSED_BYTES + 1;
    // Encode a huge byte-length delta, but lay the table 16 bytes past the first
    // chunk so the file stays tiny — the reader never touches the chunk payload.
    const t = await readLazChunkTable(
      src(
        buildLazFixture({
          compressor: 2,
          chunkSize: 250,
          pointCount: 250,
          chunkByteSizes: [bytes],
          physicalGap: 16,
        }),
      ),
    );
    expect(t.supported).toBe(false);
    if (!t.supported) expect(t.reason).toContain('compressed bytes, too large');
  });
});

describe('executeHeavyLasBuild — an over-cap LAZ fails closed heavy', () => {
  it('returns heavy:true refused with convert guidance, no OPFS touch', async () => {
    const points = MAX_LAZ_CHUNK_POINTS + 1;
    const buf = buildLazFixture({
      compressor: 3,
      chunkSize: 0xffffffff,
      pointCount: points,
      chunkByteSizes: [5000],
      chunkPointCounts: [points],
    });
    const file = { name: 'pathological.laz', size: buf.byteLength } as unknown as File;
    const facts = {
      format: 'laz',
      declaredPointCount: points,
      offsetToPointData: HEADER_SIZE + VLR_HEADER + LASZIP_PAYLOAD,
    } as unknown as LasHeaderFacts;

    let opfsAsked = false;
    const env: Partial<HeavyLasBridgeEnv> = {
      openRange: (): RangeSource => src(buf),
      getOpfsRoot: async () => {
        opfsAsked = true;
        return null;
      },
    };
    const result = await executeHeavyLasBuild(
      file,
      new AbortController().signal,
      facts,
      {} as unknown as HeavyLasBridgeDeps,
      env,
    );
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.heavy).toBe(true);
      expect(result.error.message).toContain('COPC or EPT');
    }
    // Refused from the chunk-table read alone: OPFS is never consulted, so no
    // store directory is created and no huge decode buffer is allocated.
    expect(opfsAsked).toBe(false);
  });
});

describe('planChunkWindow — window-span cap', () => {
  it('shrinks a window whose aggregate span would exceed the cap', () => {
    const big = Math.floor(MAX_LAZ_WINDOW_SPAN_BYTES / 2) - 10;
    // Three legal-but-large chunks packed back to back; a window of 3 would span
    // ~1.5x the cap. The planner must take fewer so the span stays under it.
    const chunks = [chunk(0, big), chunk(big, big), chunk(2 * big, big)];
    const plan = planChunkWindow(chunks, 0, 3);
    expect(plan.spanLength).toBeLessThanOrEqual(MAX_LAZ_WINDOW_SPAN_BYTES);
    expect(plan.end).toBe(2); // only the first two chunks fit one span
  });

  it('always advances by at least one chunk', () => {
    const huge = MAX_LAZ_WINDOW_SPAN_BYTES; // a single chunk at the cap boundary
    const plan = planChunkWindow([chunk(0, huge)], 0, 4);
    expect(plan.end).toBe(1);
    expect(plan.spanLength).toBe(huge);
  });

  it('keeps a normal run of small chunks in one window', () => {
    const chunks = [chunk(0, 1000), chunk(1000, 1200), chunk(2200, 900), chunk(3100, 1100)];
    const plan = planChunkWindow(chunks, 0, 4);
    expect(plan.end).toBe(4);
    expect(plan.spanLength).toBe(4200);
  });
});

describe('regression — the committed multichunk fixture is unaffected', () => {
  function loadFixture(name: string): ArrayBuffer {
    const b = readFileSync(resolve(__dirname, 'fixtures', name));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  it('is still supported and decodes every point', async () => {
    const range = src(loadFixture('multichunk.laz'));
    const table = await readLazChunkTable(range);
    expect(table.supported).toBe(true);
    if (!table.supported) return;
    // Its real ~40k-point chunks sit far under both per-chunk caps.
    for (const ch of table.chunks) {
      expect(ch.pointCount).toBeLessThanOrEqual(MAX_LAZ_CHUNK_POINTS);
      expect(ch.byteLength).toBeLessThanOrEqual(MAX_LAZ_CHUNK_COMPRESSED_BYTES);
    }
    const source = await openChunkedLazSource(src(loadFixture('multichunk.laz')));
    let decoded = 0;
    for await (const batch of source.source.batches()) decoded += batch.count;
    expect(decoded).toBe(source.pointCount);
  });
});
