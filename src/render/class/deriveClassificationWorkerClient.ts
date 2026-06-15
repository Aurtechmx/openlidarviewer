/**
 * deriveClassificationWorkerClient.ts
 *
 * Main-thread client for the classifier worker. Mirrors the terrain-core
 * client: lazily construct the Worker, give every request a monotonic job id,
 * settle the matching reply, drop a stale reply for an already-settled job, and
 * let an AbortSignal reject + abandon a request.
 *
 * The caller's Float32Array is NEVER detached — a COPY of its buffer is
 * transferred to the worker. The derived `codes` come back transferred
 * zero-copy.
 *
 * Browser-bound (owns a Worker) — not imported in Node unit tests; the
 * fallback path in {@link deriveClassificationAsync} is what the tests cover.
 */

import type {
  DeriveClassificationOptions,
  DeriveClassificationResult,
} from './deriveClassification';

interface PendingRequest {
  resolve: (result: DeriveClassificationResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface OkReply {
  jobId: number;
  ok: true;
  codes: Uint8Array;
  counts: Record<number, number>;
  cellSizeM: number;
  gridWidth: number;
  gridHeight: number;
  provenance: string;
}
interface ErrorReply {
  jobId: number;
  ok: false;
  error: string;
}
type WorkerReply = OkReply | ErrorReply;

/** The minimal client surface {@link deriveClassificationAsync} drives. */
export interface DeriveClassificationClientLike {
  classify(
    positions: Float32Array,
    n: number,
    options: DeriveClassificationOptions,
    signal?: AbortSignal,
  ): Promise<DeriveClassificationResult>;
}

/** Runs {@link deriveClassification} in a dedicated worker, one job at a time. */
export class DeriveClassificationWorkerClient implements DeriveClassificationClientLike {
  private _worker: Worker | null = null;
  private readonly _pending = new Map<number, PendingRequest>();
  private _nextJobId = 0;
  private _disposed = false;

  classify(
    positions: Float32Array,
    n: number,
    options: DeriveClassificationOptions,
    signal?: AbortSignal,
  ): Promise<DeriveClassificationResult> {
    const jobId = this._nextJobId++;
    return new Promise<DeriveClassificationResult>((resolve, reject) => {
      if (this._disposed) {
        reject(new Error('The classifier worker has been disposed.'));
        return;
      }
      if (signal?.aborted) {
        reject(new Error('Classification aborted'));
        return;
      }
      const worker = this._ensureWorker();

      const pending: PendingRequest = { resolve, reject, signal };
      if (signal) {
        pending.onAbort = (): void => {
          if (!this._pending.delete(jobId)) return;
          reject(new Error('Classification aborted'));
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this._pending.set(jobId, pending);

      const copy = positions.slice();
      worker.postMessage(
        { jobId, positions: copy.buffer, n, options },
        [copy.buffer],
      );
    });
  }

  dispose(): void {
    this._disposed = true;
    this._failAll(new Error('The classifier worker has been disposed.'));
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  }

  private _ensureWorker(): Worker {
    if (this._worker) return this._worker;
    const worker = new Worker(new URL('./deriveClassificationWorker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<WorkerReply>): void => {
      this._onMessage(event.data);
    };
    worker.onerror = (): void => {
      this._failAll(new Error('The classifier worker failed.'));
    };
    this._worker = worker;
    return worker;
  }

  private _onMessage(reply: WorkerReply): void {
    const pending = this._pending.get(reply.jobId);
    if (!pending) return;
    this._pending.delete(reply.jobId);
    if (pending.onAbort && pending.signal) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    if (reply.ok) {
      pending.resolve({
        codes: reply.codes,
        counts: reply.counts,
        cellSizeM: reply.cellSizeM,
        gridWidth: reply.gridWidth,
        gridHeight: reply.gridHeight,
        derived: true,
        provenance: reply.provenance,
      });
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
