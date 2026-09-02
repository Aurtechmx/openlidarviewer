/**
 * lazStridedParallelDecode.test.ts — a STRIDED chunk-parallel decode is
 * byte-identical to the legacy strided decoder.
 *
 * The fast-load path decodes a huge cloud at a stride, and that sample is what
 * the display — and every terrain product derived from it — is built on. So the
 * parallel decode is only usable if it keeps EXACTLY the records `decodeLaz`
 * keeps, in the same order, with every attribute the same: not the same count,
 * the same bytes. These cases decode the committed multi-chunk LAZ both ways at
 * several strides and compare every output array element by element, including
 * with chunks completing out of order (what a worker pool actually does).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLasHeader } from '../src/io/lasHeader';
import { computeOrigin } from '../src/io/coordinateBridge';
import { decodeLaz, getLazPerf } from '../src/io/lazDecode';
import {
  decodeLazChunkedSequential,
  decodeLazParallel,
  decodeLazChunkLocal,
} from '../src/io/heavy/decodeLazChunked';
import { stratifiedSampleIndices } from '../src/io/strideSample';
import { readLazChunkTable } from '../src/io/heavy/lazChunkTable';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import type { RawPoints } from '../src/io/lasDecodeShared';

function loadFixture(name: string): ArrayBuffer {
  const b = readFileSync(resolve(__dirname, 'fixtures', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const ORIGIN: [number, number, number] = computeOrigin([500000, 4100000, 190]);

/** Every array of a `RawPoints`, compared element by element. */
function expectIdentical(actual: RawPoints, expected: RawPoints): void {
  expect(actual.positions.length).toBe(expected.positions.length);
  expect(actual.positions).toEqual(expected.positions);
  expect(actual.intensity).toEqual(expected.intensity);
  expect(actual.classification).toEqual(expected.classification);
  expect(actual.returnNumber).toEqual(expected.returnNumber);
  expect(actual.returnCount).toEqual(expected.returnCount);
  expect(actual.pointSourceId).toEqual(expected.pointSourceId);
  expect(actual.gpsTime).toEqual(expected.gpsTime);
  expect(actual.colors).toEqual(expected.colors);
  // The staged 16-bit buffer must be released by the single per-file narrowing,
  // on both paths — a leftover would mean colour was narrowed somewhere else.
  expect(actual.colors16).toBeNull();
}

describe('strided chunk-parallel LAZ decode', () => {
  const strides = [2, 3, 7, 10, 97];

  it.each(strides)('stride %i: parallel decode equals decodeLaz, element for element', async (stride) => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const lazPerf = await getLazPerf();

    const legacy = await decodeLaz(buf, header, ORIGIN, stride);
    const parallel = await decodeLazParallel(
      buf,
      header,
      ORIGIN,
      async (job) => decodeLazChunkLocal(lazPerf, job),
      { stride },
    );

    expect(parallel, 'chunked path supports this file').not.toBeNull();
    expectIdentical(parallel!, legacy);
    // The output is sized to the SAMPLE, not the file.
    expect(parallel!.positions.length / 3).toBe(Math.ceil(header.pointCount / stride));
  });

  it.each(strides)('stride %i: the sequential chunked decoder agrees too', async (stride) => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const legacy = await decodeLaz(buf, header, ORIGIN, stride);
    const chunked = await decodeLazChunkedSequential(buf, header, ORIGIN, { stride });
    expect(chunked).not.toBeNull();
    expectIdentical(chunked!, legacy);
  });

  it('holds when the chunks complete out of order, as a worker pool makes them', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const lazPerf = await getLazPerf();
    const legacy = await decodeLaz(buf, header, ORIGIN, 10);

    // Later chunks resolve first: assembly must place by output index, never by
    // arrival. A deterministic reversal, so the case cannot pass by luck.
    let seen = 0;
    const parallel = await decodeLazParallel(
      buf,
      header,
      ORIGIN,
      async (job) => {
        const decoded = decodeLazChunkLocal(lazPerf, job);
        const delay = 4 - (seen++ % 4);
        for (let i = 0; i < delay; i++) await Promise.resolve();
        return decoded;
      },
      { stride: 10, maxInFlight: 8 },
    );
    expect(parallel).not.toBeNull();
    expectIdentical(parallel!, legacy);
  });

  it('the sample genuinely spans several chunks, so the split is exercised', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buf));
    expect(table.supported).toBe(true);
    if (!table.supported) return;
    expect(table.chunks.length).toBeGreaterThan(1);

    // Every chunk of this fixture contributes kept records at stride 10 — the
    // split is a real partition, not one chunk carrying the whole sample.
    const sample = stratifiedSampleIndices(header.pointCount, 10);
    for (const c of table.chunks) {
      const inChunk = sample.filter(
        (i) => i >= c.firstPointIndex && i < c.firstPointIndex + c.pointCount,
      );
      expect(inChunk.length).toBeGreaterThan(0);
    }
    expect(sample.length).toBe(Math.ceil(header.pointCount / 10));
  });

  it('fails closed on a file the chunk table cannot describe, at a stride too', async () => {
    const tiny = loadFixture('tiny.las');
    const header = parseLasHeader(tiny);
    const out = await decodeLazChunkedSequential(tiny, header, computeOrigin([0, 0, 0]), {
      stride: 5,
    });
    expect(out).toBeNull();
  });
});
