/**
 * decodeLazChunked.test.ts — the chunk-parallel decode's correctness floor.
 *
 * The chunked path must produce EXACTLY what the legacy whole-file decoder
 * produces; the only thing that changes is that the work is split across the
 * chunk table so a worker pool can spread it over cores. This reads a committed
 * multi-chunk LAZ (written by the real LAS writer, compressed by PDAL, so its
 * chunk table is a real laszip one) and asserts the two decoders agree
 * bit-for-bit on positions, GPS time and colour.
 *
 * The fixture is committed so this runs in CI without PDAL; the benchmark that
 * needs many sizes generates its own fixtures under LAZ_DECODE_BENCH.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLasHeader } from '../src/io/lasHeader';
import { computeOrigin } from '../src/io/coordinateBridge';
import { decodeLaz } from '../src/io/lazDecode';
import {
  decodeLazChunkedSequential,
  decodeLazParallel,
  decodeLazParallelFromSource,
  decodeLazChunkLocal,
  previewChunkIndices,
  planPreview,
  PREVIEW_MAX_CHUNKS,
} from '../src/io/heavy/decodeLazChunked';
import { getLazPerf } from '../src/io/lazDecode';
import { readLazChunkTable } from '../src/io/heavy/lazChunkTable';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { LocalFileRangeSource } from '../src/io/range/LocalFileRangeSource';
import type { RangeSource } from '../src/io/range/RangeSource';

function loadFixture(name: string): ArrayBuffer {
  const b = readFileSync(resolve(__dirname, 'fixtures', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

describe('chunked LAZ decode', () => {
  it('is bit-identical to the legacy whole-file decoder, and multi-chunk', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);

    // The fixture must genuinely span more than one chunk, or this proves nothing.
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buf));
    expect(table.supported, 'fixture is a chunked LAZ').toBe(true);
    if (table.supported) expect(table.chunks.length, 'fixture spans several chunks').toBeGreaterThan(1);

    const seq = await decodeLaz(buf, header, origin, 1);
    const chunked = await decodeLazChunkedSequential(buf, header, origin);
    expect(chunked, 'chunked path supports this file').not.toBeNull();

    expect(chunked!.positions.length).toBe(seq.positions.length);
    expect(chunked!.positions).toEqual(seq.positions);
    if (seq.gpsTime) expect(chunked!.gpsTime).toEqual(seq.gpsTime);
    if (seq.colors) expect(chunked!.colors).toEqual(seq.colors);
  });

  it('the parallel orchestrator assembles identically to the sequential decoder', async () => {
    // A synchronous in-process chunk decoder stands in for the worker pool: this
    // proves the fan-out/assembly and the single whole-file colour narrowing are
    // correct, independent of whether the chunks ran on one core or many.
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);
    const seq = await decodeLaz(buf, header, origin, 1);
    const lazPerf = await getLazPerf();

    const parallel = await decodeLazParallel(buf, header, origin, async (job) =>
      decodeLazChunkLocal(lazPerf, job),
    );
    expect(parallel).not.toBeNull();
    expect(parallel!.positions).toEqual(seq.positions);
    if (seq.gpsTime) expect(parallel!.gpsTime).toEqual(seq.gpsTime);
    if (seq.colors) expect(parallel!.colors).toEqual(seq.colors);
  });

  it('hands a bounded, file-spread preview first and still assembles the full output identically', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);
    const seq = await decodeLaz(buf, header, origin, 1);
    const lazPerf = await getLazPerf();
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buf));
    if (!table.supported) throw new Error('fixture is a chunked LAZ');
    const previewIdx = previewChunkIndices(table.chunks.length, 2);
    expect(previewIdx).toEqual([0, table.chunks.length - 1]);

    const decodedOrder: number[] = [];
    let preview: Awaited<ReturnType<typeof decodeLaz>> | null = null;
    let placedWhenPreviewed = -1;
    let plannedInfo: { chunkCount: number; previewChunks: number; previewPoints: number } | null = null;
    const parallel = await decodeLazParallel(
      buf,
      header,
      origin,
      async (job) => {
        decodedOrder.push(job.firstPointIndex);
        return decodeLazChunkLocal(lazPerf, job);
      },
      {
        maxInFlight: 1,
        previewChunks: 2,
        onPlanned: (info) => { plannedInfo = info; },
        onPreview: (p) => {
          preview = p;
          placedWhenPreviewed = decodedOrder.length;
        },
      },
    );
    expect(parallel).not.toBeNull();
    expect(parallel!.positions).toEqual(seq.positions);

    // The preview arrived after exactly the preview chunks, which decoded first.
    expect(preview).not.toBeNull();
    expect(placedWhenPreviewed).toBe(previewIdx.length);
    expect(decodedOrder.slice(0, previewIdx.length)).toEqual(previewIdx.map((i) => table.chunks[i].firstPointIndex));
    expect(plannedInfo).toEqual({ chunkCount: table.chunks.length, previewChunks: 2, previewPoints: preview!.positions.length / 3 });

    // Its records are the preview chunks' records, in file order, unchanged.
    const expected: number[] = [];
    for (const i of previewIdx) {
      const c = table.chunks[i];
      for (let k = c.firstPointIndex * 3; k < (c.firstPointIndex + c.pointCount) * 3; k++) expected.push(seq.positions[k]);
    }
    expect(Array.from(preview!.positions)).toEqual(expected);
  });

  it('spreads a bounded number of preview chunks over the file, first and last included', () => {
    expect(previewChunkIndices(1)).toEqual([]);
    expect(previewChunkIndices(2)).toEqual([0, 1]);
    expect(previewChunkIndices(5)).toEqual([0, 1, 2, 3, 4]);
    const spread = previewChunkIndices(200);
    expect(spread).toHaveLength(PREVIEW_MAX_CHUNKS);
    expect(spread[0]).toBe(0);
    expect(spread[spread.length - 1]).toBe(199);
    expect(new Set(spread).size).toBe(spread.length);
    for (let i = 1; i < spread.length; i++) expect(spread[i]).toBeGreaterThan(spread[i - 1]);
    // Twenty thousand chunks cost the same number of preview decodes as two hundred.
    expect(previewChunkIndices(20_000)).toHaveLength(PREVIEW_MAX_CHUNKS);
    expect(previewChunkIndices(3, 2)).toEqual([0, 2]);
  });

  it('drops preview chunks from the tail of the spread until the point cap fits, keeping one', () => {
    const chunk = (firstPointIndex: number, pointCount: number) =>
      ({ range: { byteOffset: 0, byteLength: 1, pointCount, firstPointIndex }, outIndex: firstPointIndex });
    const chunks = Array.from({ length: 10 }, (_, i) => chunk(i * 50_000, 50_000));
    expect(planPreview(chunks, 4, 1_000_000)).toEqual([0, 3, 6, 9]);
    expect(planPreview(chunks, 4, 120_000)).toEqual([0, 3]);
    expect(planPreview(chunks, 4, 10)).toEqual([0]);
  });

  it('never calls onPreview when the decode is not chunked', async () => {
    const tiny = loadFixture('tiny.las');
    const header = parseLasHeader(tiny);
    const lazPerf = await getLazPerf();
    let previews = 0;
    const out = await decodeLazParallel(tiny, header, computeOrigin([0, 0, 0]), async (job) =>
      decodeLazChunkLocal(lazPerf, job), { onPreview: () => { previews++; } });
    expect(out).toBeNull();
    expect(previews).toBe(0);
  });

  it('decodes from a File by range, one read per chunk, never the whole file, identically', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);
    const seq = await decodeLaz(buf, header, origin, 1);
    const lazPerf = await getLazPerf();
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buf));
    if (!table.supported) throw new Error('fixture is a chunked LAZ');

    const inner = new LocalFileRangeSource(new File([buf], 'm.laz'));
    const reads: Array<[number, number]> = [];
    const counted: RangeSource = {
      id: () => inner.id(),
      kind: () => inner.kind(),
      size: () => inner.size(),
      readRange: (offset, length, signal) => {
        reads.push([offset, length]);
        return inner.readRange(offset, length, signal);
      },
    };
    const out = await decodeLazParallelFromSource(counted, header, origin, async (job) =>
      decodeLazChunkLocal(lazPerf, job), { maxInFlight: 3 });
    expect(out).not.toBeNull();
    expect(out!.positions).toEqual(seq.positions);
    expect(out!.intensity).toEqual(seq.intensity);
    expect(out!.classification).toEqual(seq.classification);

    // Every chunk was read exactly once, at its own range.
    for (const c of table.chunks) {
      expect(reads.filter(([o, l]) => o === c.byteOffset && l === c.byteLength)).toHaveLength(1);
    }
    // No read covered the file: the largest is a chunk or the table's prefix.
    const largest = Math.max(...reads.map(([, l]) => l));
    expect(largest).toBeLessThan(buf.byteLength);
  });

  it('fails closed (returns null) on a non-chunked input rather than guessing', async () => {
    // An uncompressed LAS has no laszip VLR, so the chunk-table reader reports
    // unsupported and the decoder returns null for the caller to fall back.
    const tiny = loadFixture('tiny.las');
    const header = parseLasHeader(tiny);
    const out = await decodeLazChunkedSequential(tiny, header, computeOrigin([0, 0, 0]));
    expect(out).toBeNull();
  });
});
