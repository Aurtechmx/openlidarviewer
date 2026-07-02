/**
 * eptLaszipWorkerClient.ts
 *
 * The main-thread client for the EPT laszip decode worker. Mirrors
 * `copc/worker/copcWorkerClient.ts`: each `decodeTile()` carries a request id;
 * an `AbortSignal` rejects that request and posts a `cancel` so a not-yet-
 * started decode is skipped; a result for an already-settled request is dropped.
 *
 * The EPT chunk decoder (`EptChunkDecoder`) holds one of these and routes the
 * `laszip` data-type through it. The worker is created lazily by `main.ts` and
 * lives as long as the session, like the COPC decode worker.
 *
 * The `Worker` is created through an injectable factory so the request-id
 * multiplexing, abort, and error-mapping logic can be unit-tested against a
 * fake worker with no browser. The default factory creates the real module
 * worker.
 */

import type { DecodedChunk } from '../../copc/copcChunkDecode';

/** The minimal `Worker` surface this client uses — lets tests supply a fake. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface PendingRequest {
  resolve: (decoded: DecodedChunk) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** ms at request post — wall-time decode timing for the streaming benchmark. */
  startedAt: number;
}

interface DecodedReply {
  type: 'decoded';
  requestId: number;
  decoded: DecodedChunk;
}
interface ErrorReply {
  type: 'error';
  requestId: number;
  error: string;
}
type WorkerReply = DecodedReply | ErrorReply;

/** Create the real module worker. Browser-only — never called in Node tests. */
function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('./eptLaszipWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

/** Decodes EPT laszip tiles in a dedicated worker, off the main thread. */
export class EptLaszipWorkerClient {
  private readonly _worker: WorkerLike;
  private readonly _pending = new Map<number, PendingRequest>();
  private _nextRequestId = 0;
  private _disposed = false;

  /**
   * Optional hook called after each successful decode with the wall-time
   * elapsed from postMessage to result. The streaming benchmark wires this.
   */
  onDecodeMs: ((ms: number) => void) | undefined;

  constructor(workerFactory: () => WorkerLike = defaultWorkerFactory) {
    this._worker = workerFactory();
    this._worker.onmessage = (event: MessageEvent): void => {
      this._onMessage(event.data as WorkerReply);
    };
    this._worker.onerror = (): void => {
      this._failAll(new Error('The EPT laszip decode worker failed.'));
    };
  }

  /**
   * Decode one complete EPT laszip tile. The `tile` buffer is transferred to
   * the worker — the caller must not reuse it after the call. `renderOrigin` is
   * the EPT cloud's per-cloud Float64 shift, applied inside the worker.
   * `rgbEightBit` is the dataset-level RGB bit-depth decision (pinned from
   * the first decoded RGB tile), forwarded to the decode core so every tile
   * narrows colour identically.
   */
  decodeTile(
    tile: ArrayBuffer,
    renderOrigin: readonly [number, number, number],
    signal?: AbortSignal,
    rgbEightBit?: boolean,
  ): Promise<DecodedChunk> {
    const requestId = this._nextRequestId++;
    return new Promise<DecodedChunk>((resolve, reject) => {
      if (this._disposed) {
        reject(new Error('The EPT laszip decode worker has been disposed.'));
        return;
      }
      if (signal?.aborted) {
        reject(new Error('EPT decode aborted'));
        return;
      }
      const pending: PendingRequest = { resolve, reject, signal, startedAt: nowMs() };
      if (signal) {
        pending.onAbort = (): void => {
          if (!this._pending.delete(requestId)) return;
          this._worker.postMessage({ type: 'cancel', requestId });
          reject(new Error('EPT decode aborted'));
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this._pending.set(requestId, pending);
      this._worker.postMessage(
        { type: 'decode', requestId, tile, renderOrigin: [...renderOrigin], rgbEightBit },
        [tile],
      );
    });
  }

  /** Terminate the worker and reject every in-flight decode. */
  dispose(): void {
    this._disposed = true;
    this._failAll(new Error('The EPT laszip decode worker has been disposed.'));
    this._worker.terminate();
  }

  private _onMessage(reply: WorkerReply): void {
    const pending = this._pending.get(reply.requestId);
    if (!pending) return; // cancelled or already settled — drop the stale reply
    this._pending.delete(reply.requestId);
    if (pending.onAbort && pending.signal) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    if (reply.type === 'decoded') {
      this.onDecodeMs?.(nowMs() - pending.startedAt);
      pending.resolve(reply.decoded);
    } else {
      pending.reject(new Error(reply.error));
    }
  }

  private _failAll(error: Error): void {
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
  }
}

/** A monotonic millisecond clock, available on both the main thread and workers. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
