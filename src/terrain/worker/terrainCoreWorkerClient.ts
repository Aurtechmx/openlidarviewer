/**
 * terrainCoreWorkerClient.ts
 *
 * Main-thread client for the terrain-core compute worker. Mirrors the COPC
 * decode worker client: lazily construct the `Worker`, give every request a
 * monotonic job id, settle the matching reply, drop a stale reply for an
 * already-settled job, and let an `AbortSignal` reject a request AND terminate
 * the worker running it (the compute is synchronous inside one message task, so
 * termination is the only cancellation that reaches it; the worker is lazily
 * rebuilt on the next call).
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

  /** In-flight job count. Diagnostic — asserted by the settlement tests. */
  get pendingCount(): number {
    return this._pending.size;
  }

  /**
   * Compute a terrain core in the worker. The `positions` array is COPIED (its
   * buffer is never detached), so the caller may keep using it after the call.
   * Rejects if the signal is (or becomes) aborted; an abort also terminates the
   * worker, so the abandoned compute actually stops instead of running to
   * completion for a result nobody will read.
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
          if (!this._settle(jobId)) return;
          reject(new Error('Terrain analysis aborted'));
          // Abandoning the PROMISE is not abandoning the WORK. The worker's
          // `onmessage` runs the whole terrain compute synchronously inside one
          // message task, so a "cancel" message could not be read until the run
          // it was meant to cancel had already finished — `terminate()` is the
          // only mechanism that actually stops it. Without this an aborted
          // analysis (the user changed the cell size, or closed the panel) kept
          // a core pinned for the full duration of a compute whose result
          // nobody would ever read, and the NEXT analysis queued behind it.
          //
          // Terminating takes the whole worker down, so any other job riding it
          // dies too; `_terminateWorker` rejects those rather than leaving them
          // unsettled, and their caller falls back to the main-thread compute.
          // The worker is lazily rebuilt, so the next call gets a clean one.
          this._terminateWorker(
            new Error('The terrain-core worker was terminated by an aborted job.'),
          );
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
      try {
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
      } catch (err) {
        // A synchronous post failure (e.g. DataCloneError, or posting to a
        // worker that just died) would otherwise strand this job in `_pending`
        // with its abort listener still attached. Settle it and surface the
        // error so the async wrapper's fallback path runs.
        this._settle(jobId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Terminate the worker and reject every in-flight job. */
  dispose(): void {
    this._disposed = true;
    this._terminateWorker(new Error('The terrain-core worker has been disposed.'));
  }

  /**
   * Reject every job still in flight, terminate the live worker, and drop the
   * reference so {@link _ensureWorker} respawns a clean one on the next call.
   *
   * The single "stop the machine" path, shared by `dispose` and by an abort.
   * Rejecting BEFORE terminating matters: once the worker is gone no reply can
   * arrive, so a job left in `_pending` would hang forever.
   */
  private _terminateWorker(error: Error): void {
    this._failAll(error);
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
      // The worker died. Reject the in-flight job (so the async wrapper's
      // main-thread fallback fires) and DROP the dead worker so the next job
      // respawns a fresh one — leaving it installed would post into a corpse
      // that never replies, hanging the promise and defeating the fallback.
      this._failAll(new Error('The terrain-core worker failed.'));
      worker.terminate();
      if (this._worker === worker) this._worker = null;
    };
    this._worker = worker;
    return worker;
  }

  private _onMessage(reply: WorkerReply): void {
    const pending = this._settle(reply.jobId);
    if (!pending) return; // aborted or already settled — drop the stale reply
    if (reply.ok) {
      pending.resolve(reply.core);
    } else {
      pending.reject(new Error(reply.error));
    }
  }

  /**
   * Remove a job from `_pending` and detach its abort listener, returning it
   * (or undefined if already gone). The single teardown path, so a reply, a
   * sync post failure, and a fail-all all clean up identically — no map entry
   * or signal listener is ever left behind.
   */
  private _settle(jobId: number): PendingRequest | undefined {
    const pending = this._pending.get(jobId);
    if (!pending) return undefined;
    this._pending.delete(jobId);
    if (pending.onAbort && pending.signal) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    return pending;
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
