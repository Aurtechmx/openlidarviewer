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
  ClassifierProvenance,
  DeriveClassificationOptions,
  DeriveClassificationResult,
} from './deriveClassification';

interface PendingRequest {
  resolve: (result: DeriveClassificationResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  onProgress?: (phase: string) => void;
  /** Reply-deadline timer; cleared by every teardown path, reset by progress. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * How long one job may go without ANY message before the worker is declared
 * hung, terminated and the job failed (which routes the caller into the bounded
 * main-thread fallback). The classifier worker posts a progress message per
 * phase, and each one RESETS this timer, so a legitimately long derive is never
 * killed: only a worker that has gone quiet is.
 */
export const CLASSIFY_WORKER_REPLY_DEADLINE_MS = 120_000;

/** Constructor options. `replyDeadlineMs` exists so tests can inject a small one. */
export interface DeriveClassificationWorkerClientOptions {
  readonly replyDeadlineMs?: number;
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
  confidence: number;
  classConfidence: Record<number, number>;
  warnings: readonly string[];
  classifier: ClassifierProvenance;
}
interface ErrorReply {
  jobId: number;
  ok: false;
  error: string;
}
/** A mid-run progress message — carries no `ok`, never settles the job. */
interface ProgressReply {
  jobId: number;
  phase: string;
}
type WorkerReply = OkReply | ErrorReply | ProgressReply;

/** The minimal client surface {@link deriveClassificationAsync} drives. */
export interface DeriveClassificationClientLike {
  classify(
    positions: Float32Array,
    n: number,
    options: DeriveClassificationOptions,
    signal?: AbortSignal,
    onProgress?: (phase: string) => void,
  ): Promise<DeriveClassificationResult>;
}

/** Runs {@link deriveClassification} in a dedicated worker, one job at a time. */
export class DeriveClassificationWorkerClient implements DeriveClassificationClientLike {
  private _worker: Worker | null = null;
  private readonly _pending = new Map<number, PendingRequest>();
  private _nextJobId = 0;
  private _disposed = false;
  private readonly _replyDeadlineMs: number;

  constructor(options?: DeriveClassificationWorkerClientOptions) {
    this._replyDeadlineMs = options?.replyDeadlineMs ?? CLASSIFY_WORKER_REPLY_DEADLINE_MS;
  }

  /** In-flight job count. Diagnostic — asserted by the settlement tests. */
  get pendingCount(): number {
    return this._pending.size;
  }

  classify(
    positions: Float32Array,
    n: number,
    options: DeriveClassificationOptions,
    signal?: AbortSignal,
    onProgress?: (phase: string) => void,
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

      const pending: PendingRequest = { resolve, reject, signal, onProgress };
      if (signal) {
        pending.onAbort = (): void => {
          // Settle (not a bare delete) so the job's reply-deadline timer is
          // cleared with it; a stray timer would later tear down a worker that
          // belongs to the NEXT job.
          if (!this._settle(jobId)) return;
          reject(new Error('Classification aborted'));
          // The worker is single-job: the aborted job IS its current work, so
          // rejecting the promise alone would leave it computing to the end
          // and then replying to nobody. Terminate it and drop it; the next
          // job respawns a fresh one. Any other job queued behind this one is
          // failed rather than silently lost with the worker.
          this._failAll(new Error('The classifier worker was torn down by an abort.'));
          if (this._worker) {
            this._worker.terminate();
            this._worker = null;
          }
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this._armDeadline(pending);
      this._pending.set(jobId, pending);

      // Copy then TRANSFER: the caller's Float32Array must never be detached
      // (it's the live cloud's positions), so we hand the worker a throwaway
      // copy's buffer it can own zero-copy. The transient ~2× memory during the
      // call is deliberate — correctness over saving one buffer.
      const copy = positions.slice();
      try {
        worker.postMessage(
          { jobId, positions: copy.buffer, n, options },
          [copy.buffer],
        );
      } catch (err) {
        // A synchronous post failure (e.g. DataCloneError, or posting to a
        // worker that just died) would otherwise strand this job in `_pending`
        // with its abort listener still attached. Settle it and surface the
        // error to the caller.
        this._settle(jobId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
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

  /**
   * (Re)start the reply deadline for one job. Called on post and again on every
   * progress message, so the clock measures SILENCE, not total run time.
   */
  private _armDeadline(pending: PendingRequest): void {
    if (!(this._replyDeadlineMs > 0) || !Number.isFinite(this._replyDeadlineMs)) return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      // A worker that never replies used to hang this promise forever, which
      // also meant the bridge's fallback never ran. Fail every job and drop the
      // worker so the caller falls back (or refuses on measurement) instead.
      this._failAll(
        new Error(
          `The classifier worker missed its ${this._replyDeadlineMs} ms reply deadline.`,
        ),
      );
      if (this._worker) {
        this._worker.terminate();
        this._worker = null;
      }
    }, this._replyDeadlineMs);
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
      // The worker died. Reject the in-flight job and DROP the dead worker so
      // the next job respawns a fresh one — leaving it installed would post
      // into a corpse that never replies, hanging the promise (this client has
      // no timeout) and defeating any fallback.
      this._failAll(new Error('The classifier worker failed.'));
      worker.terminate();
      if (this._worker === worker) this._worker = null;
    };
    this._worker = worker;
    return worker;
  }

  private _onMessage(reply: WorkerReply): void {
    // Progress messages report a phase and do NOT settle the job — peek
    // without removing so a later real reply for the same job still lands.
    if (!('ok' in reply)) {
      const pending = this._pending.get(reply.jobId);
      if (!pending) return;
      // The worker is alive and working: give the job a fresh deadline.
      this._armDeadline(pending);
      pending.onProgress?.(reply.phase);
      return;
    }
    const pending = this._settle(reply.jobId);
    if (!pending) return; // aborted or already settled — drop the stale reply
    if (reply.ok) {
      pending.resolve({
        codes: reply.codes,
        counts: reply.counts,
        cellSizeM: reply.cellSizeM,
        gridWidth: reply.gridWidth,
        gridHeight: reply.gridHeight,
        derived: true,
        provenance: reply.provenance,
        confidence: reply.confidence,
        classConfidence: reply.classConfidence,
        warnings: reply.warnings,
        classifier: reply.classifier,
      });
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
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (pending.onAbort && pending.signal) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    return pending;
  }

  private _failAll(error: Error): void {
    for (const pending of this._pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      if (pending.onAbort && pending.signal) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.reject(error);
    }
    this._pending.clear();
  }
}
