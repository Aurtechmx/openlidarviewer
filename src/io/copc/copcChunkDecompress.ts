/**
 * copcChunkDecompress.ts
 *
 * laz-perf decompression of one compressed COPC node chunk into raw
 * concatenated LAS records — the WASM half of the worker's decode, extracted
 * from `worker/copcWorker.ts` so the malformed-chunk boundary is unit-testable
 * in Node (the worker file itself needs a `DedicatedWorkerGlobalScope`).
 *
 * laz-perf is compiled without exception catching: on a corrupt LAZ stream its
 * chunk decoder aborts by throwing a raw Emscripten value ("<address> —
 * Exception catching is disabled…"), not an `Error`. That must never surface
 * to a caller, so every failure leaves here as a typed
 * `LoadError('malformed-file', …)` whose message names COPC. The word
 * "malformed" in the messages is deliberate: workers post `error.message`
 * strings across the thread boundary, and `classifyLoadError` keys on it to
 * recover the category on the main thread.
 *
 * Pure — no DOM, no three.js; the caller supplies the instantiated module.
 */

import type { createLazPerf } from 'laz-perf';
import { LoadError } from '../loadErrors';
import { validateDeclaredPointCount } from '../validateCount';
import type { ChunkDecodeMetadata } from './copcChunkDecode';

/** The instantiated laz-perf WASM module. */
export type LazPerfModule = Awaited<ReturnType<typeof createLazPerf>>;

/**
 * Hard ceiling on points in a single COPC node. The hierarchy parser
 * (`copcHierarchy.ts`) accepts any positive int32 point count, but real
 * COPC nodes are bounded in practice — writers target tens of thousands
 * of points per node; even pathological single-node files stay far under
 * this. A node claiming more is malformed, and honouring it would size
 * `pointCount * recordLength` output buffers (plus the decoded attribute
 * arrays in `decodeRecords`) into the gigabytes.
 */
export const MAX_NODE_POINTS = 50_000_000;

/**
 * Decompress one COPC node chunk into raw concatenated LAS records using
 * laz-perf's per-chunk `ChunkDecoder` — the same `open(pdrf, recordLength,
 * pointer)` + N×`getPoint` contract a C++ COPC reader uses.
 *
 * Throws `LoadError('malformed-file')` when the declared point count is
 * implausible for the bytes present, or when laz-perf rejects the stream.
 */
export function decompressChunk(
  lazPerf: LazPerfModule,
  chunk: ArrayBuffer,
  meta: ChunkDecodeMetadata,
): Uint8Array {
  // Allocation guard — bound the node's declared count by its compressed
  // bytes (1 byte/point is far below any genuine LAZ stream) and by the
  // practical node ceiling BEFORE sizing the output buffer below.
  const pointCount = validateDeclaredPointCount(
    meta.pointCount,
    chunk.byteLength,
    1,
    'COPC node',
  );
  if (pointCount > MAX_NODE_POINTS) {
    throw new LoadError(
      'malformed-file',
      `malformed COPC: node claims ${pointCount.toLocaleString('en-US')} points ` +
        `(limit ${MAX_NODE_POINTS.toLocaleString('en-US')}).`,
    );
  }

  const compressed = new Uint8Array(chunk);
  const recordLength = meta.pointRecordLength;
  const chunkPtr = lazPerf._malloc(compressed.byteLength);
  const pointPtr = lazPerf._malloc(recordLength);
  const decoder = new lazPerf.ChunkDecoder();
  try {
    lazPerf.HEAPU8.set(compressed, chunkPtr);
    decoder.open(meta.pointDataRecordFormat, recordLength, chunkPtr);
    const out = new Uint8Array(pointCount * recordLength);
    for (let i = 0; i < pointCount; i++) {
      decoder.getPoint(pointPtr);
      // `HEAPU8` is re-read each iteration — laz-perf may grow (and detach) it.
      out.set(
        lazPerf.HEAPU8.subarray(pointPtr, pointPtr + recordLength),
        i * recordLength,
      );
    }
    return out;
  } catch (err) {
    if (err instanceof LoadError) throw err;
    // A corrupt LAZ stream — laz-perf aborted with a raw Emscripten value.
    throw new LoadError(
      'malformed-file',
      'malformed COPC node chunk: LAZ decompression failed — the compressed data is corrupt or truncated.',
    );
  } finally {
    decoder.delete();
    lazPerf._free(pointPtr);
    lazPerf._free(chunkPtr);
  }
}
