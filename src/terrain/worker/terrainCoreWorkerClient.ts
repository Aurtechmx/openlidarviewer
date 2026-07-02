/**
 * terrainCoreWorkerClient.ts
 *
 * Main-thread client for the terrain-core compute worker. Mirrors the COPC
 * decode worker client: lazily construct the `Worker`, give every request a
 * monotonic job id, settle the matching reply, drop a stale reply for an
 * already-settled job, and let an `AbortSignal` reject + abandon a request.
 *
 * Serialization choice (safety first):
 *   - INPUT: the caller's working Float32Array is NEVER detached. We send a
 *     COPY of the buffer (`positions.slice().buffer`) and TRANSFER that copy,
 *     so the worker gets zero-copy ownership of a buffer the main thread no
 *     longer needs, while the caller's array stays fully intact.
 *   - RESULT: the `core` is structured-cloned back (its typed-array grids clone
 *     correctly). Correctness over micro-optimization — the win is moving the
 *     COMPUTE off-thread, not zero-copy on the (much smaller) result.
 *
 * Browser-bound (owns a `Worker`) — not imported in Node unit tests. The
 * fallback path (see {@link computeTerrainCoreAsync}) is what the tests cover.
 */

import type { TerrainCore, TerrainCoreParams } from '../contour/analyseContours';

interface PendingRequest {
  resolve: (core: TerrainCore) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface OkReply {
  jobId: number;
  ok: true;
  core: TerrainCore;
}
interface ErrorReply {
  jobId: number;
  ok: false;
  error: string;
}
type WorkerReply = OkReply | ErrorReply;

/** Runs {@link computeTerrainCore} in a dedicated worker, one job at a time. */
export class TerrainCoreWorkerClient {
  private _worker: Worker | null = null;
  private readonly _pending = new Map<number, PendingRequest>();
  private _nextJobId = 0;
  private _disposed = false;

  /**
   * Compute a terrain core in the worker. The `positions` array is COPIED (its
   * buffer is never detached), so the caller may keep using it after the call.
   * Rejects if the signal is (or becomes) aborted, dropping the worker's reply.
   *
   * Throws synchronously / rejects if the worker cannot be constructed — the
   * caller's {@link computeTerrainCoreAsync} wrapper catches this and falls back
   * to the main-thread compute.
   */
  computeCore(
    positions: Float32Array,
    n: number,
    coreParams: TerrainCoreParams,
    classification: ReadonlyArray<number> | Uint8Array | undefined,
    signal?: AbortSignal,
  ): Promise<TerrainCore> {
    const jobId = this._nextJobId++;
    // Clamp the caller-supplied count to what the buffer actually holds. The
    // worker rebuilds its view as `new Float32Array(buffer, 0, n·3)`, so an
    // oversized `n` would THROW there — and because a worker error funnels
    // into the safe main-thread fallback, the mistake would silently cost the
    // off-thread path instead of being corrected here. Floor + ≥0 also guards
    // fractional/negative counts.
    const nClamped = Math.min(
      Math.max(0, Math.floor(n)),
      Math.floor(positions.length / 3),
    );
    return new Promise<TerrainCore>((resolve, reject) => {
      if (this._disposed) {
        reject(new Error('The terrain-core worker has been disposed.'));
        return;
      }
      if (signal?.aborted) {
        reject(new Error('Terrain analysis aborted'));
        return;
      }
      // Construct the worker on first use. A construction failure rejects so the
      // async wrapper can fall back to the main thread.
      const worker = this._ensureWorker();

      const pending: PendingRequest = { resolve, reject, signal };
      if (signal) {
        pending.onAbort = (): void => {
          // Drop the job so a reply that arrives later is treated as stale.
          if (!this._pending.delete(jobId)) return;
          reject(new Error('Terrain analysis aborted'));
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this._pending.set(jobId, pending);

      // Copy the buffer so the caller's Float32Array is never detached, then
      // transfer the COPY (zero-copy hand-off of a buffer we no longer need).
      const copy = positions.slice();
      // Strip classification from coreParams; it is carried as its own field so
      // the worker can re-attach it (avoids cloning it twice).
      const { classification: _drop, ...paramsNoClass } = coreParams;
      void _drop;
      worker.postMessage(
        {
          jobId,
          positions: copy.buffer,
          n: nClamped,
          coreParams: paramsNoClass,
          classification,
        },
        [copy.buffer],
      );
    });
  }

  /** Terminate the worker and reject every in-flight job. */
  dispose(): void {
    this._disposed = true;
    this._failAll(new Error('The terrain-core worker has been disposed.'));
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  }

  /** Lazily build the worker; throws if construction fails. */
  private _ensureWorker(): Worker {
    if (this._worker) return this._worker;
    const worker = new Worker(new URL('./terrainCoreWorker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<WorkerReply>): void => {
      this._onMessage(event.data);
    };
    worker.onerror = (): void => {
      this._failAll(new Error('The terrain-core worker failed.'));
    };
    this._worker = worker;
    return worker;
  }

  private _onMessage(reply: WorkerReply): void {
    const pending = this._pending.get(reply.jobId);
    if (!pending) return; // aborted or already settled — drop the stale reply
    this._pending.delete(reply.jobId);
    if (pending.onAbort && pending.signal) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    if (reply.ok) {
      pending.resolve(reply.core);
    } else {
      pending.reject(new Error(reply.error));
    }
  }

  private _failAll(error: Error): void {
    for (const pending of this._pending.values()) {
      if (pending.onAbort && pending.signal) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.reject(error);
    }
    this._pending.clear();
  }
}
