/**
 * copcWorker.ts
 *
 * The COPC chunk-decode worker. Heavy LAZ decompression runs here, off the
 * main thread: a compressed COPC node chunk in, decoded local-space attribute
 * arrays out (transferred zero-copy).
 *
 * The laz-perf WASM module is instantiated once and reused for every chunk.
 * Requests carry an id; a `cancel` message marks an id so a not-yet-started
 * request is skipped — the scheduler uses this to drop stale work.
 */

import { createLazPerf } from 'laz-perf';
import { LAZ_PERF_WASM_BASE64 } from '../../lazPerfWasm';
import { decodeRecords, chunkTransferables } from '../copcChunkDecode';
import type { ChunkDecodeMetadata } from '../copcChunkDecode';
import { decompressChunk } from '../copcChunkDecompress';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface DecodeMessage {
  type: 'decode';
  requestId: number;
  chunk: ArrayBuffer;
  meta: ChunkDecodeMetadata;
}
interface CancelMessage {
  type: 'cancel';
  requestId: number;
}
type InMessage = DecodeMessage | CancelMessage;

/** Request ids cancelled before the worker reached them. */
const cancelled = new Set<number>();

/** Decode the embedded base64 laz-perf WASM into bytes. */
function lazPerfWasmBinary(): Uint8Array {
  const binary = atob(LAZ_PERF_WASM_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type LazPerfModule = Awaited<ReturnType<typeof createLazPerf>>;
let lazPerfPromise: Promise<LazPerfModule> | undefined;

/** Instantiate the laz-perf WASM module once; reuse it for every chunk. */
function getLazPerf(): Promise<LazPerfModule> {
  const existing = lazPerfPromise;
  if (existing) return existing;
  const created = createLazPerf({ wasmBinary: lazPerfWasmBinary() }).catch(
    (err: unknown) => {
      lazPerfPromise = undefined;
      throw err;
    },
  );
  lazPerfPromise = created;
  return created;
}

// The decompression itself (allocation guard + laz-perf ChunkDecoder +
// malformed-chunk error translation) lives in `../copcChunkDecompress` so the
// boundary is unit-testable in Node. Errors cross the worker boundary as a
// plain message string (see the catch below); the typed LoadError's message
// deliberately contains "malformed", so it is re-classified correctly on the
// main thread.

ctx.onmessage = (event: MessageEvent<InMessage>): void => {
  const msg = event.data;

  if (msg.type === 'cancel') {
    cancelled.add(msg.requestId);
    // A cancel message always arrives after its decode message, so once the
    // WASM module is warm (decodes then run to completion before the next
    // message) most cancel ids are stale the instant they are added. Bound the
    // set — clearing it only risks a few already-superseded decodes running,
    // and the client drops their results regardless.
    if (cancelled.size > 256) cancelled.clear();
    return;
  }
  if (msg.type !== 'decode') return;

  const { requestId, chunk, meta } = msg;
  if (cancelled.has(requestId)) {
    cancelled.delete(requestId);
    return;
  }

  void (async (): Promise<void> => {
    try {
      const lazPerf = await getLazPerf();
      if (cancelled.has(requestId)) {
        cancelled.delete(requestId);
        return;
      }
      const raw = decompressChunk(lazPerf, chunk, meta);
      const decoded = decodeRecords(raw, meta);
      ctx.postMessage(
        { type: 'decoded', requestId, decoded },
        chunkTransferables(decoded),
      );
    } catch (err) {
      ctx.postMessage({
        type: 'error',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
