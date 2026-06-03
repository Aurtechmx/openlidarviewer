/**
 * copcWorkerClient.ts
 *
 * The main-thread client for the COPC decode worker. It implements the
 * `ChunkDecoder` interface, so the streaming scheduler depends only on that
 * interface — and tests can swap in a fake decoder with no worker at all.
 *
 * Each `decode()` carries a request id. An `AbortSignal` rejects that request
 * and posts a `cancel` to the worker so a not-yet-started decode is skipped;
 * a result that arrives for an already-settled request is simply dropped.
 *
 * Browser-bound (owns a `Worker`) — not imported in Node unit tests.
 */

import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../copcChunkDecode';

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

/** A `ChunkDecoder` that runs COPC chunk decoding in a dedicated worker. */
export class CopcWorkerClient implements ChunkDecoder {
  private readonly _worker: Worker;
  private readonly _pending = new Map<number, PendingRequest>();
  private _nextRequestId = 0;
  private _disposed = false;

  /**
   * Optional hook called after each successful decode with the wall-time
   * elapsed from postMessage to result. The streaming benchmark wires this.
   */
  onDecodeMs: ((ms: number) => void) | undefined;

  constructor() {
    this._worker = new Worker(new URL('./copcWorker.ts', import.meta.url), {
      type: 'module',
    });
    this._worker.onmessage = (event: MessageEvent<WorkerReply>): void => {
      this._onMessage(event.data);
    };
    this._worker.onerror = (): void => {
      this._failAll(new Error('The COPC decode worker failed.'));
    };
  }

  /**
   * Decode a compressed COPC node chunk. The `chunk` buffer is transferred to
   * the worker — the caller must not reuse it after the call.
   */
  decode(
    chunk: ArrayBuffer,
    meta: ChunkDecodeMetadata,
    signal?: AbortSignal,
  ): Promise<DecodedChunk> {
    const requestId = this._nextRequestId++;
    return new Promise<DecodedChunk>((resolve, reject) => {
      if (this._disposed) {
        reject(new Error('The COPC decode worker has been disposed.'));
        return;
      }
      if (signal?.aborted) {
        reject(new Error('Decode aborted'));
        return;
      }
      const pending: PendingRequest = { resolve, reject, signal, startedAt: nowMs() };
      if (signal) {
        pending.onAbort = (): void => {
          if (!this._pending.delete(requestId)) return;
          this._worker.postMessage({ type: 'cancel', requestId });
          reject(new Error('Decode aborted'));
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this._pending.set(requestId, pending);
      this._worker.postMessage({ type: 'decode', requestId, chunk, meta }, [chunk]);
    });
  }

  /** Terminate the worker and reject every in-flight decode. */
  dispose(): void {
    this._disposed = true;
    this._failAll(new Error('The COPC decode worker has been disposed.'));
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
