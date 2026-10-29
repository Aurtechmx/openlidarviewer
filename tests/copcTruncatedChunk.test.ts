/**
 * laz-perf's ChunkDecoder is opened on a pointer with no length, so a node
 * chunk shorter than its compressed size is decoded by reading whatever WASM
 * heap follows it: the result is a full set of points, partly made of memory
 * that was never part of the file (measured on Zenodo 15421291 iPhone.laz: the
 * output from half of a 458,467-byte node depends on the bytes after the input
 * from point 404 on, and no error is raised). The decoder cannot see this, so
 * decompressChunk checks the chunk against the node's declared compressed size
 * before decoding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { decompressChunk } from '../src/io/copc/copcChunkDecompress';
import { getLazPerf } from '../src/io/lazDecode';
import { LoadError } from '../src/io/loadErrors';
import { parseLasHeader } from '../src/io/lasHeader';
import { readLazChunkTable } from '../src/io/heavy/lazChunkTable';
import { decodeLazChunkLocal } from '../src/io/heavy/decodeLazChunked';
import { decodeContext } from '../src/io/lasDecodeShared';

async function largestNode() {
  const b = readFileSync(new URL('./fixtures/copc/terrain-access-utm.copc.laz', import.meta.url));
  const stream = await StreamingPointCloud.open(new ArrayBufferRangeSource(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer), 'utm.copc.laz');
  const node = stream.octree.nodes().map((n) => n.record).sort((a, c) => c.byteSize - a.byteSize)[0];
  return { stream, node, chunk: await stream.readNodeChunk(node) };
}

describe('a truncated COPC node chunk', () => {
  it('the decode metadata carries the node\'s declared compressed size', async () => {
    const { stream, node } = await largestNode();
    expect(stream.decodeMeta(node).compressedBytes).toBe(node.byteSize);
  });

  it('is refused with a typed error instead of decoding into a full set of points', async () => {
    const { stream, node, chunk } = await largestNode();
    const lazPerf = await getLazPerf();
    const meta = stream.decodeMeta(node);
    expect(decompressChunk(lazPerf, chunk, meta).byteLength).toBe(node.pointCount * meta.pointRecordLength);
    let err: unknown;
    try { decompressChunk(lazPerf, chunk.slice(0, chunk.byteLength >> 1), meta); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).category).toBe('malformed-file');
    expect((err as Error).message).toMatch(/truncated/);
  });
});

describe('a COPC node chunk longer than declared', () => {
  it('is refused too', async () => {
    const { stream, node, chunk } = await largestNode();
    const lazPerf = await getLazPerf();
    const longer = new Uint8Array(chunk.byteLength + 16);
    longer.set(new Uint8Array(chunk));
    expect(() => decompressChunk(lazPerf, longer, stream.decodeMeta(node))).toThrow(LoadError);
  });
});

describe('a chunked LAZ chunk of the wrong length', () => {
  const b = readFileSync(new URL('./fixtures/multichunk-pdrf3.laz', import.meta.url));
  const buffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const header = parseLasHeader(buffer);

  async function firstJob() {
    const table = await readLazChunkTable(new ArrayBufferRangeSource(buffer), undefined, header.offsetToPointData);
    if (!table.supported) throw new Error('fixture chunk table unsupported');
    const c = table.chunks[0]!;
    const bytes = new Uint8Array(buffer, c.byteOffset, c.byteLength).slice();
    const job = {
      chunk: bytes, compressedBytes: c.byteLength,
      pointCount: c.pointCount, firstPointIndex: c.firstPointIndex,
      pointDataRecordFormat: header.pointFormat, pointRecordLength: header.pointDataRecordLength,
      scale: header.scale, offset: header.offset, ctx: decodeContext(header, [0, 0, 0]),
    };
    return { job, bytes, lazPerf: await getLazPerf() };
  }

  it('decodes when the chunk matches the chunk-table size', async () => {
    const { job, lazPerf } = await firstJob();
    expect(decodeLazChunkLocal(lazPerf, job).positions.length).toBe(job.pointCount * 3);
  });

  it('is refused when shorter than the chunk-table size', async () => {
    const { job, bytes, lazPerf } = await firstJob();
    expect(() => decodeLazChunkLocal(lazPerf, { ...job, chunk: bytes.subarray(0, bytes.byteLength >> 1) })).toThrow(/truncated/);
  });

  it('is refused when longer than the chunk-table size', async () => {
    const { job, bytes, lazPerf } = await firstJob();
    const longer = new Uint8Array(bytes.byteLength + 16);
    longer.set(bytes);
    expect(() => decodeLazChunkLocal(lazPerf, { ...job, chunk: longer })).toThrow(LoadError);
  });
});
