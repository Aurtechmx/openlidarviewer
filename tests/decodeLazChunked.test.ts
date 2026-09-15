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
  decodeLazChunkLocal,
  previewChunkIndices,
  PREVIEW_CHUNK_STEP,
} from '../src/io/heavy/decodeLazChunked';
import { getLazPerf } from '../src/io/lazDecode';
import { readLazChunkTable } from '../src/io/heavy/lazChunkTable';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';

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

  it('hands a preview of the early chunks first and still assembles the full output identically', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);
    const seq = await decodeLaz(buf, header, origin, 1);
    const lazPerf = await getLazPerf();
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buf));
    if (!table.supported) throw new Error('fixture is a chunked LAZ');
    const previewIdx = previewChunkIndices(table.chunks.length);
    expect(previewIdx[0]).toBe(0);

    const decodedOrder: number[] = [];
    let preview: Awaited<ReturnType<typeof decodeLaz>> | null = null;
    let placedWhenPreviewed = -1;
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
    const firstDecoded = decodedOrder.slice(0, previewIdx.length);
    expect(firstDecoded).toEqual(previewIdx.map((i) => table.chunks[i].firstPointIndex));

    // Its records are the preview chunks' records, in file order, unchanged.
    const expected: number[] = [];
    for (const i of previewIdx) {
      const c = table.chunks[i];
      for (let k = c.firstPointIndex * 3; k < (c.firstPointIndex + c.pointCount) * 3; k++) {
        expected.push(seq.positions[k]);
      }
    }
    expect(Array.from(preview!.positions)).toEqual(expected);
    expect(preview!.colors === null).toBe(seq.colors === null);
  });

  it('previews every PREVIEW_CHUNK_STEP-th chunk and nothing for a single-chunk file', () => {
    expect(previewChunkIndices(1)).toEqual([]);
    expect(previewChunkIndices(2)).toEqual([0]);
    expect(previewChunkIndices(PREVIEW_CHUNK_STEP + 1)).toEqual([0, PREVIEW_CHUNK_STEP]);
    expect(previewChunkIndices(3 * PREVIEW_CHUNK_STEP)).toEqual([0, PREVIEW_CHUNK_STEP, 2 * PREVIEW_CHUNK_STEP]);
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

  it('fails closed (returns null) on a non-chunked input rather than guessing', async () => {
    // An uncompressed LAS has no laszip VLR, so the chunk-table reader reports
    // unsupported and the decoder returns null for the caller to fall back.
    const tiny = loadFixture('tiny.las');
    const header = parseLasHeader(tiny);
    const out = await decodeLazChunkedSequential(tiny, header, computeOrigin([0, 0, 0]));
    expect(out).toBeNull();
  });
});
