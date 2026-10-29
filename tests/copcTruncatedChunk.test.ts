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
