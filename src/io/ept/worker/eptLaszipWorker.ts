/**
 * eptLaszipWorker.ts
 *
 * The EPT laszip tile-decode worker. The CPU-bound work — laz-perf
 * decompression plus the per-record coordinate transform — runs here, off the
 * main thread: a complete LAZ tile in, decoded local-space attribute arrays out
 * (transferred zero-copy).
 *
 * This is the EPT sibling of `copc/worker/copcWorker.ts`. The difference is the
 * unit of work: a COPC chunk is a raw decompressed node body sharing one
 * file-level LAS header, whereas each EPT laszip tile is a COMPLETE LAZ file
 * with its own header. So this worker hands the whole tile to the shared decode
 * core (`decodeEptLaszipTileWith`) — the same core the in-process fallback runs
 * — rather than re-implementing the record walk.
 *
 * The laz-perf WASM module is instantiated once from the embedded base64 blob
 * and reused for every tile. Requests carry an id; a `cancel` message marks an
 * id so a not-yet-started request is skipped — the scheduler uses this to drop
 * stale work when the camera moves on.
 */

import { createLazPerf } from 'laz-perf';
import { LAZ_PERF_WASM_BASE64 } from '../../lazPerfWasm';
import { decodeEptLaszipTileWith } from '../eptLaszipDecode';
import { chunkTransferables } from '../../copc/copcChunkDecode';
import { CancelledRequestSet } from '../../workerPool/cancelledRequestSet';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface DecodeMessage {
  type: 'decode';
  requestId: number;
  tile: ArrayBuffer;
  renderOrigin: [number, number, number];
  /** Dataset-level RGB bit-depth decision (pinned from the first RGB tile);
   *  undefined until the source has seen one — the decode then decides and
   *  reports back via `DecodedChunk.rgbEightBit`. */
  rgbEightBit?: boolean;
}
interface CancelMessage {
  type: 'cancel';
  requestId: number;
}
type InMessage = DecodeMessage | CancelMessage;

/**
 * Request ids cancelled before the worker reached them. Bounded, evicting the
 * OLDEST ids when it overflows — see `workerPool/cancelledRequestSet` for why
 * clearing the whole set instead threw away the cancellations that still had
 * work to save. One instance per worker; a pooled sibling has its own.
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

/** Instantiate the laz-perf WASM module once; reuse it for every tile. */
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

ctx.onmessage = (event: MessageEvent<InMessage>): void => {
  const msg = event.data;

  if (msg.type === 'cancel') {
    // A cancel always arrives after its decode message, so once the WASM module
    // is warm many cancel ids are already stale when they are added. The set
    // bounds itself by evicting the oldest ids, which are exactly the ones
    // whose decode has already been dealt with.
    cancelled.add(msg.requestId);
    return;
  }
  if (msg.type !== 'decode') return;

  const { requestId, tile, renderOrigin, rgbEightBit } = msg;
  // Every accepted request must post exactly ONE terminal reply. A silent return
  // on a consumed cancel leaves the pool's slot held forever (its job is only
  // cleared by a reply), so a cancel-consume return posts `cancelled` first.
  if (cancelled.consume(requestId)) {
    ctx.postMessage({ type: 'cancelled', requestId });
    return;
  }

  void (async (): Promise<void> => {
    try {
      const lazPerf = await getLazPerf();
      if (cancelled.consume(requestId)) {
        ctx.postMessage({ type: 'cancelled', requestId });
        return;
      }
      const decoded = decodeEptLaszipTileWith(lazPerf, tile, renderOrigin, rgbEightBit);
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
