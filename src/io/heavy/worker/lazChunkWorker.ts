/**
 * lazChunkWorker.ts
 *
 * The local-LAZ chunk-decode worker. A chunked `.laz` file carries a table of
 * independent per-chunk byte ranges (see `heavy/lazChunkTable.ts`); each chunk
 * is a self-contained decode unit. This worker decodes ONE chunk off the main
 * thread — a compressed chunk plus its small scalars in, a chunk-local
 * `RawPoints` out (its backing buffers transferred zero-copy) — so a pool of
 * these decodes a dense cloud's chunks in parallel, one per core.
 *
 * It shares the exact extract path the legacy whole-file decoder uses
 * (`decodeLazChunkLocal` → `decompressChunk` + `decodeRecord`), so the assembled
 * output is byte-for-byte identical to `decodeLaz`. Colours are left STAGED
 * (`colors16`): the 8-bit-vs-16-bit narrowing is a per-file decision the main
 * thread makes once after every chunk is placed, so two chunks can never
 * disagree on colour depth.
 *
 * The laz-perf WASM module is instantiated once per worker and reused for every
 * chunk. Requests carry an id; a `cancel` message marks an id so a not-yet-run
 * request is skipped — mirroring the COPC worker so both share the pool.
 */

import { createLazPerf } from 'laz-perf';
import { LAZ_PERF_WASM_BASE64 } from '../../lazPerfWasm';
import { CancelledRequestSet } from '../../workerPool/cancelledRequestSet';
import { rawPointsTransferables } from '../../lasDecodeShared';
import { decodeLazChunkLocal, type LazChunkJob } from '../decodeLazChunked';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface DecodeMessage {
  type: 'decode';
  requestId: number;
  job: LazChunkJob;
}
interface CancelMessage {
  type: 'cancel';
  requestId: number;
}
type InMessage = DecodeMessage | CancelMessage;

/**
 * Request ids cancelled before the worker reached them. Bounded, evicting the
 * OLDEST ids on overflow (see `workerPool/cancelledRequestSet`). One instance
 * per worker; a pooled sibling has its own.
 */
const cancelled = new CancelledRequestSet();

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
  const created = createLazPerf({ wasmBinary: lazPerfWasmBinary() }).catch((err: unknown) => {
    lazPerfPromise = undefined;
    throw err;
  });
  lazPerfPromise = created;
  return created;
}

ctx.onmessage = (event: MessageEvent<InMessage>): void => {
  const msg = event.data;

  if (msg.type === 'cancel') {
    cancelled.add(msg.requestId);
    return;
  }
  if (msg.type !== 'decode') return;

  const { requestId, job } = msg;
  if (cancelled.consume(requestId)) return;

  void (async (): Promise<void> => {
    try {
      const lazPerf = await getLazPerf();
      if (cancelled.consume(requestId)) return;
      const decoded = decodeLazChunkLocal(lazPerf, job);
      ctx.postMessage({ type: 'decoded', requestId, decoded }, rawPointsTransferables(decoded));
    } catch (err) {
      ctx.postMessage({
        type: 'error',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
