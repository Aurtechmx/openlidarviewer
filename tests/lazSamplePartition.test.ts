/**
 * lazSamplePartition.test.ts
 *
 * A strided chunked LAZ decode splits the whole-file stratified sample across
 * the chunk table. Each chunk's kept indices must be exactly the slice of
 * `stratifiedSampleIndices` it owns, in order, with the same output offsets,
 * whether or not the whole-file list is ever built. `reference` is the
 * partition as it stood: build the list, then slice it at the chunk edges.
 */

import { describe, expect, it } from 'vitest';
import { partitionSample, type PlannedChunk } from '../src/io/heavy/decodeLazChunked';
import { stratifiedSampleIndices } from '../src/io/strideSample';
import type { LazChunkRange } from '../src/io/heavy/lazChunkTable';

function reference(chunks: readonly LazChunkRange[], count: number, step: number): PlannedChunk[] {
  const sample = stratifiedSampleIndices(count, step);
  const planned: PlannedChunk[] = [];
  let read = 0;
  let outIndex = 0;
  for (const range of chunks) {
    const end = range.firstPointIndex + range.pointCount;
    const start = read;
    while (read < sample.length && sample[read]! < end) read++;
    const keep = new Uint32Array(read - start);
    for (let j = 0; j < keep.length; j++) keep[j] = sample[start + j]! - range.firstPointIndex;
    planned.push({ range, keep, outIndex });
    outIndex += keep.length;
  }
  return planned;
}

function table(sizes: number[]): LazChunkRange[] {
  let first = 0;
  return sizes.map((pointCount, i) => {
    const r = { byteOffset: i * 100, byteLength: 100, pointCount, firstPointIndex: first };
    first += pointCount;
    return r;
  });
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
}

describe('partitionSample', () => {
  it('matches slicing the whole-file sample at the chunk edges', () => {
    const cases: Array<[number[], number]> = [
      [[50_000, 50_000, 20_000], 3],
      [[50_000, 50_000, 20_000], 7.9],
      [[50_000, 0, 50_000, 1], 1],
      [[1, 1, 1, 1, 1], 2],
      [[10], 100],
      [[0], 4],
    ];
    const rnd = prng(12);
    for (let k = 0; k < 40; k++) {
      const sizes = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => Math.floor(rnd() * 40_000));
      cases.push([sizes, 1 + rnd() * 60]);
    }
    for (const [sizes, step] of cases) {
      const chunks = table(sizes);
      const count = sizes.reduce((a, b) => a + b, 0);
      const got = partitionSample(chunks, count, step);
      const want = reference(chunks, count, step);
      expect(got).toHaveLength(want.length);
      for (let i = 0; i < want.length; i++) {
        expect(got[i]!.outIndex, `${sizes} / ${step} chunk ${i}`).toBe(want[i]!.outIndex);
        expect(got[i]!.range).toBe(want[i]!.range);
        expect(Buffer.compare(Buffer.from(got[i]!.keep!.buffer, got[i]!.keep!.byteOffset, got[i]!.keep!.byteLength), Buffer.from(want[i]!.keep!.buffer)), `${sizes} / ${step} chunk ${i}`).toBe(0);
      }
    }
  });
});
