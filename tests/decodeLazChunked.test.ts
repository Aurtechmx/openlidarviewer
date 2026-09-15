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

  it('hands every chunk on as it is placed, and still assembles the full output identically', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);
    const seq = await decodeLaz(buf, header, origin, 1);
    const lazPerf = await getLazPerf();
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buf));
    if (!table.supported) throw new Error('fixture is a chunked LAZ');

    const handed: Array<{ positions: Float32Array; outIndex: number }> = [];
    let planned: { chunkCount: number; expectedPoints: number } | null = null;
    const parallel = await decodeLazParallel(
      buf,
      header,
      origin,
      async (job) => decodeLazChunkLocal(lazPerf, job),
      {
        maxInFlight: 2,
        onPlanned: (info) => { planned = info; },
        onPreviewChunk: (records, outIndex) => { handed.push({ positions: records.positions, outIndex }); },
      },
    );
    expect(parallel).not.toBeNull();
    expect(parallel!.positions).toEqual(seq.positions);
    expect(planned).toEqual({ chunkCount: table.chunks.length, expectedPoints: header.pointCount });

    // One hand-off per chunk, each the chunk's own dense records, equal to the
    // output slice it was placed at.
    expect(handed).toHaveLength(table.chunks.length);
    let total = 0;
    for (const h of handed) {
      const n = h.positions.length / 3;
      total += n;
      expect(Array.from(h.positions)).toEqual(Array.from(seq.positions.subarray(h.outIndex * 3, (h.outIndex + n) * 3)));
    }
    expect(total).toBe(header.pointCount);
  });

  it('hands chunks on at a stride too, each the kept subset of its chunk', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);
    const seq = await decodeLaz(buf, header, origin, 7);
    const lazPerf = await getLazPerf();
    let total = 0;
    const parallel = await decodeLazParallel(buf, header, origin, async (job) => decodeLazChunkLocal(lazPerf, job), {
      stride: 7,
      onPreviewChunk: (records, outIndex) => {
        const n = records.positions.length / 3;
        total += n;
        expect(Array.from(records.positions)).toEqual(Array.from(seq.positions.subarray(outIndex * 3, (outIndex + n) * 3)));
      },
    });
    expect(parallel!.positions).toEqual(seq.positions);
    expect(total).toBe(seq.positions.length / 3);
  });

  it('never hands a chunk on when the decode is not chunked', async () => {
    const tiny = loadFixture('tiny.las');
    const header = parseLasHeader(tiny);
    const lazPerf = await getLazPerf();
    let handed = 0;
    const out = await decodeLazParallel(tiny, header, computeOrigin([0, 0, 0]), async (job) =>
      decodeLazChunkLocal(lazPerf, job), { onPreviewChunk: () => { handed++; } });
    expect(out).toBeNull();
    expect(handed).toBe(0);
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
