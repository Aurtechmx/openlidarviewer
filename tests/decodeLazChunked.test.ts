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
  samplePreviewPositions,
  previewStrideFor,
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
        onPreviewChunk: (positions, outIndex) => { handed.push({ positions, outIndex }); },
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
      onPreviewChunk: (positions, outIndex) => {
        const n = positions.length / 3;
        total += n;
        expect(Array.from(positions)).toEqual(Array.from(seq.positions.subarray(outIndex * 3, (outIndex + n) * 3)));
      },
    });
    expect(parallel!.positions).toEqual(seq.positions);
    expect(total).toBe(seq.positions.length / 3);
  });

  it('samples the preview by one global stride, so only the budget crosses the boundary', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);
    const seq = await decodeLaz(buf, header, origin, 1);
    const lazPerf = await getLazPerf();
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buf));
    if (!table.supported) throw new Error('fixture is a chunked LAZ');

    const previewBudget = 5_000;
    const stride = previewStrideFor(header.pointCount, previewBudget);
    expect(stride, 'the fixture is larger than the budget').toBeGreaterThan(1);

    const run = async (maxInFlight: number): Promise<Array<{ outIndex: number; positions: Float32Array }>> => {
      const handed: Array<{ outIndex: number; positions: Float32Array }> = [];
      const out = await decodeLazParallel(buf, header, origin, async (job) => decodeLazChunkLocal(lazPerf, job), {
        maxInFlight,
        previewBudget,
        onPreviewChunk: (positions, outIndex) => { handed.push({ outIndex, positions: positions.slice() }); },
      });
      // The decode itself is untouched by the preview sampling.
      expect(out!.positions).toEqual(seq.positions);
      return handed;
    };
    const assembled = (handed: Array<{ outIndex: number; positions: Float32Array }>): number[] =>
      [...handed].sort((a, b) => a.outIndex - b.outIndex).flatMap((h) => Array.from(h.positions));

    // The records at global indices 0, stride, 2*stride, ... and no others.
    const expected: number[] = [];
    for (let g = 0; g < header.pointCount; g += stride) {
      expected.push(seq.positions[g * 3], seq.positions[g * 3 + 1], seq.positions[g * 3 + 2]);
    }

    const oneLane = await run(1);
    const manyLanes = await run(7);
    expect(assembled(oneLane)).toEqual(expected);
    // The union does not depend on the order the chunks finished in.
    expect(assembled(manyLanes)).toEqual(assembled(oneLane));

    const total = expected.length / 3;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(previewBudget);
    expect(total).toBeGreaterThanOrEqual(previewBudget - table.chunks.length);
    // Which is a small fraction of what the unbounded hand-off used to post.
    expect(total).toBeLessThan(header.pointCount / 10);
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

describe('samplePreviewPositions', () => {
  /** `n` records whose x is `base + local index`, so a kept record names itself. */
  const chunkOf = (n: number, base: number): Float32Array => {
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a[i * 3] = base + i;
    return a;
  };
  const xs = (a: Float32Array): number[] => Array.from(a).filter((_, k) => k % 3 === 0);

  it('keeps the records whose GLOBAL index is a multiple of the stride', () => {
    // Locals 0..9 placed at output index 7, so globals 7..16; stride 5 keeps
    // globals 10 and 15, which are locals 3 and 8.
    expect(xs(samplePreviewPositions(chunkOf(10, 100), 7, 5)!)).toEqual([103, 108]);
  });

  it('returns null for a chunk the sample misses and the buffer itself at stride 1', () => {
    const chunk = chunkOf(2, 0);
    expect(samplePreviewPositions(chunk, 1, 10)).toBeNull();
    expect(samplePreviewPositions(new Float32Array(0), 0, 4)).toBeNull();
    expect(samplePreviewPositions(chunk, 0, 1)).toBe(chunk);
  });

  it('covers a contiguous output exactly once, whatever the chunk boundaries are', () => {
    const total = 37;
    const stride = 4;
    const kept: number[] = [];
    for (const [at, n] of [[0, 10], [10, 9], [19, 18]] as Array<[number, number]>) {
      const sampled = samplePreviewPositions(chunkOf(n, at), at, stride);
      if (sampled) kept.push(...xs(sampled));
    }
    const expected: number[] = [];
    for (let g = 0; g < total; g += stride) expected.push(g);
    expect(kept).toEqual(expected);
  });
});

describe('previewStrideFor', () => {
  it('is the step that fits the planned total into the budget, and 1 without one', () => {
    expect(previewStrideFor(100_000_000, 2_000_000)).toBe(50);
    expect(previewStrideFor(1_000, 2_000_000)).toBe(1);
    expect(previewStrideFor(1_000, undefined)).toBe(1);
    expect(previewStrideFor(1_000, 0)).toBe(1);
  });
});
