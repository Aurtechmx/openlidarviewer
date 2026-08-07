/**
 * DecodeWorkerPool.ts
 *
 * A pool of decode workers behind one request/reply protocol. The COPC and EPT
 * laszip decode clients both own one of these; the pool holds every rule that
 * is identical between them (request-id multiplexing, queueing, dispatch,
 * cancellation, failure isolation, disposal, timing) so neither client carries
 * a second, drifting copy.
 *
 * Pure in the sense that matters for testing: this module never calls
 * `new Worker`. Workers arrive through an injectable factory and are typed as
 * {@link WorkerLike} — the minimal surface the protocol uses — so the whole
 * pool runs in Node against a fake worker, and the two `new Worker(new URL(…))`
 * literals stay in the client modules the worker registry already declares.
 *
 * THE INVARIANTS, stated once because every method below preserves them:
 *
 *   ONE JOB PER WORKER. A slot holds at most one job. A worker is handed the
 *   next job only after the previous one's reply arrives (or the slot is torn
 *   down). Nothing here ever posts a second decode into a busy worker — the
 *   worker's laz-perf decode is synchronous and uninterruptible, so a second
 *   message would only sit in its event queue where the pool cannot see it.
 *
 *   BUFFER OWNERSHIP IS SINGLE AND TERMINAL. A submission's transfer list is
 *   owned by the pool from `submit()` until the instant it is handed to
 *   `postMessage`, and `job.transfer` is nulled at that instant. A job that has
 *   been posted is NEVER re-posted, not even to a healthy worker after another
 *   one dies: its buffers are detached and re-transferring them would throw
 *   (or, worse, silently ship an empty buffer). A dead worker's job is
 *   rejected, never rescheduled.
 *
 *   EXACTLY ONE TERMINAL OUTCOME PER REQUEST. `_settle` is the only path that
 *   removes a job from `_jobs`, and it is also the only path that detaches the
 *   abort listener. Resolve, reject-on-error, abort, sync-post failure, worker
 *   death and disposal all funnel through it, so no request can settle twice
 *   and no signal is left holding a listener.
 *
 *   A CANCELLED ACTIVE JOB DOES NOT FREE ITS WORKER. Cancelling mid-decode
 *   settles the promise immediately, but the worker is still grinding inside
 *   WASM; the slot stays busy until its reply lands and the result is dropped.
 *   Freeing the slot early would put two live decodes on one worker.
 */

/** The minimal `Worker` surface the decode protocol uses — fakeable in Node. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** A decoded reply for one request id. */
interface DecodedReply<T> {
  type: 'decoded';
  requestId: number;
  decoded: T;
}
/** A failed decode, carried as a plain message string across the boundary. */
interface ErrorReply {
  type: 'error';
  requestId: number;
  error: string;
}
type PoolReply<T> = DecodedReply<T> | ErrorReply;

/**
 * The four rejection messages a pool produces. Held per-client so the COPC and
 * EPT clients keep the exact wording their callers (and tests) already match
 * on — the streaming scheduler classifies a decode failure by message.
 */
export interface DecodePoolMessages {
  /** Rejection after `dispose()`. */
  readonly disposed: string;
  /** Rejection when the pool has no worker left that can serve a decode. */
  readonly failed: string;
  /** Rejection when the caller's `AbortSignal` fires. */
  readonly aborted: string;
  /** Rejection when the bounded queue is full. */
  readonly queueFull: string;
}

/** One unit of decode work handed to the pool. */
export interface DecodeSubmission {
  /**
   * Fields merged into the posted message, which is always
   * `{ type: 'decode', requestId, ...payload }`. The two clients' wire formats
   * differ only in these fields, so the protocol itself stays in one place.
   */
  readonly payload: Record<string, unknown>;
  /**
   * Buffers transferred with the post. Ownership passes to the pool at
   * `submit()`: the caller must not touch them afterwards, and the pool
   * transfers each one exactly once.
   */
  readonly transfer: readonly Transferable[];
  readonly signal?: AbortSignal;
  /**
   * Dispatch value — HIGHER decodes sooner. Ties break on enqueue order, so a
   * queue where no caller sets a value dispatches in strict FIFO order. This is
   * the seam a future priority/deadline-aware scheduler writes to; nothing sets
   * it today.
   */
  readonly value?: number;
}

/** Pool diagnostics — plain numbers, no worker handles. */
export interface DecodePoolStats {
  /** Configured slot count (the pool never exceeds this). */
  readonly size: number;
  /** Workers currently alive. Grows on demand, shrinks on failure. */
  readonly liveWorkers: number;
  /** Slots retired after a failure they could not be respawned from. */
  readonly retiredSlots: number;
  /** Jobs currently inside a worker. */
  readonly active: number;
  /** Jobs waiting for a free worker. */
  readonly queued: number;
  /** Jobs dispatched over the pool's lifetime. */
  readonly dispatched: number;
  /** Workers respawned after a failure over the pool's lifetime. */
  readonly respawns: number;
  /** Summed queue wait (enqueue → dispatch), ms. Never counted as decode time. */
  readonly queueWaitMs: number;
  /** Summed active decode time (dispatch → reply), ms, successful decodes only. */
  readonly activeMs: number;
  /** True once the pool has no worker left and every later submit rejects. */
  readonly broken: boolean;
  /** True once `dispose()` has run. */
  readonly disposed: boolean;
}

export interface DecodeWorkerPoolOptions {
  /** Slot count. Clamped to at least 1 — a zero-worker pool cannot decode. */
  readonly size: number;
  /** Builds one worker. May throw; a throw retires that slot, not the pool. */
  readonly createWorker: () => WorkerLike;
  readonly messages: DecodePoolMessages;
  /**
   * Bound on jobs waiting for a worker. Overflow rejects the NEW submission
   * rather than evicting an accepted one, so an accepted job always keeps its
   * exactly-one-outcome guarantee. The streaming scheduler caps itself at 4
   * concurrent decodes, so the default is never reached in normal operation —
   * it exists so a runaway caller cannot grow the queue without limit.
   */
  readonly maxQueueDepth?: number;
  /**
   * Respawn attempts per slot over the pool's lifetime. See `_onWorkerError`
   * for why a respawn additionally requires another worker to still be alive.
   */
  readonly respawnBudget?: number;
  /** Injectable monotonic clock, for deterministic timing assertions. */
  readonly now?: () => number;
}

/** Default queue bound — far above the scheduler's 4 concurrent decodes. */
const DEFAULT_MAX_QUEUE_DEPTH = 64;
/** Default respawns per slot. One retry, then the slot is retired for good. */
const DEFAULT_RESPAWN_BUDGET = 1;

/** A job from `submit()` to its single terminal outcome. */
interface PoolJob<T> {
  readonly requestId: number;
  /** Monotonic enqueue order — the FIFO tie-break behind value ordering. */
  readonly seq: number;
  readonly value: number;
  readonly payload: Record<string, unknown>;
  /**
   * The transfer list, nulled the instant it is handed to `postMessage`. A null
   * here is the proof that these buffers were already transferred and that this
   * job must never be posted again.
   */
  transfer: readonly Transferable[] | null;
  resolve: (decoded: T) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** ms at enqueue — the start of QUEUE WAIT, never of decode time. */
  readonly enqueuedAt: number;
  /** ms at post — the start of ACTIVE decode time. 0 while queued. */
  dispatchedAt: number;
  /** Owning slot index, or -1 while queued. */
  slot: number;
}

/** One worker's seat in the pool. */
interface PoolSlot<T> {
  readonly index: number;
  worker: WorkerLike | null;
  /**
   * The job this worker is running. Stays set after that job is cancelled —
   * the worker is still busy until its reply arrives — and is cleared only by
   * the reply, a worker death, or disposal.
   */
  job: PoolJob<T> | null;
  /** A retired slot is never given a worker again. */
  retired: boolean;
  respawnsLeft: number;
}

/**
 * A pool of decode workers sharing one request-id space.
 *
 * `T` is the decoded payload the workers reply with (`DecodedChunk` for both
 * current clients); the pool passes it through untouched.
 */
export class DecodeWorkerPool<T> {
  private readonly _slots: PoolSlot<T>[];
  private readonly _createWorker: () => WorkerLike;
  private readonly _messages: DecodePoolMessages;
  private readonly _maxQueueDepth: number;
  private readonly _now: () => number;

  /** Every unsettled job — queued and active alike — keyed by request id. */
  private readonly _jobs = new Map<number, PoolJob<T>>();
  /** Jobs waiting for a worker, in enqueue order. */
  private readonly _queue: PoolJob<T>[] = [];

  private _nextRequestId = 0;
  private _nextSeq = 0;
  private _disposed = false;
  private _broken = false;
  private _dispatched = 0;
  private _respawns = 0;
  private _queueWaitMs = 0;
  private _activeMs = 0;

  /**
   * Called after each successful decode with the ACTIVE time only — post to
   * reply. Queue wait is deliberately excluded: reporting it here would inflate
   * the streaming benchmark's decode figure with scheduling delay the worker
   * never spent decoding. {@link onQueueWaitMs} carries that separately.
   */
  onDecodeMs: ((ms: number) => void) | undefined;

  /** Called at dispatch with the time a job spent waiting for a free worker. */
  onQueueWaitMs: ((ms: number) => void) | undefined;

  constructor(options: DecodeWorkerPoolOptions) {
    const size = Math.max(1, Math.floor(options.size));
    this._createWorker = options.createWorker;
    this._messages = options.messages;
    this._maxQueueDepth = Math.max(1, options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH);
    this._now = options.now ?? nowMs;
    const respawnBudget = Math.max(0, options.respawnBudget ?? DEFAULT_RESPAWN_BUDGET);
    this._slots = [];
    for (let i = 0; i < size; i++) {
      this._slots.push({
        index: i,
        worker: null,
        job: null,
        retired: false,
        respawnsLeft: respawnBudget,
      });
    }
    // Slot 0 eagerly, the rest on demand. The eager one preserves the pre-warm
    // the callers rely on (constructing the client starts laz-perf's WASM boot
    // during idle time, off the first scan's critical path); the lazy ones mean
    // a session that never decodes two chunks at once never pays for a second
    // WASM heap. If slot 0 cannot be built the error propagates, exactly as the
    // single-worker client's constructor used to — the caller treats it as a
    // load failure.
    this._slots[0].worker = this._spawn(this._slots[0]);
  }

  /** Unsettled requests — queued plus active. */
  get pendingCount(): number {
    return this._jobs.size;
  }

  /** Requests waiting for a free worker. */
  get queuedCount(): number {
    return this._queue.length;
  }

  /** Requests currently inside a worker (including cancelled-but-still-running). */
  get activeCount(): number {
    let n = 0;
    for (const slot of this._slots) if (slot.job) n++;
    return n;
  }

  /** Workers currently alive. */
  get liveWorkerCount(): number {
    let n = 0;
    for (const slot of this._slots) if (slot.worker) n++;
    return n;
  }

  /** A snapshot for diagnostics. Numbers only — no worker handle escapes. */
  stats(): DecodePoolStats {
    let retired = 0;
    for (const slot of this._slots) if (slot.retired) retired++;
    return {
      size: this._slots.length,
      liveWorkers: this.liveWorkerCount,
      retiredSlots: retired,
      active: this.activeCount,
      queued: this._queue.length,
      dispatched: this._dispatched,
      respawns: this._respawns,
      queueWaitMs: this._queueWaitMs,
      activeMs: this._activeMs,
      broken: this._broken,
      disposed: this._disposed,
    };
  }

  /**
   * Queue one decode. The submission's transfer list is owned by the pool from
   * here on. Resolves with the worker's decoded payload, or rejects — exactly
   * once either way.
   */
  submit(submission: DecodeSubmission): Promise<T> {
    const requestId = this._nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      if (this._disposed) {
        reject(new Error(this._messages.disposed));
        return;
      }
      if (this._broken) {
        reject(new Error(this._messages.failed));
        return;
      }
      if (submission.signal?.aborted) {
        reject(new Error(this._messages.aborted));
        return;
      }
      if (this._queue.length >= this._maxQueueDepth) {
        reject(new Error(this._messages.queueFull));
        return;
      }
      const job: PoolJob<T> = {
        requestId,
        seq: this._nextSeq++,
        value: submission.value ?? 0,
        payload: submission.payload,
        transfer: submission.transfer,
        resolve,
        reject,
        signal: submission.signal,
        enqueuedAt: this._now(),
        dispatchedAt: 0,
        slot: -1,
      };
      if (submission.signal) {
        job.onAbort = (): void => this._onAbort(requestId);
        submission.signal.addEventListener('abort', job.onAbort, { once: true });
      }
      // Registered BEFORE the pump so a dispatch that fails synchronously finds
      // the job (and its listener) to tear down.
      this._jobs.set(requestId, job);
      this._queue.push(job);
      this._pump();
    });
  }

  /** Terminate every worker and settle every queued and active request. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._failAll(new Error(this._messages.disposed));
    for (const slot of this._slots) {
      slot.job = null;
      slot.retired = true;
      if (slot.worker) {
        try {
          slot.worker.terminate();
        } catch {
          /* best-effort teardown — a worker that is already gone needs nothing */
        }
        slot.worker = null;
      }
    }
  }

  /**
   * Hand queued work to free workers until one of the two runs out. Called
   * after every event that can change either side of that balance: a submit, a
   * reply, a cancellation, a worker death.
   */
  private _pump(): void {
    if (this._disposed || this._broken) return;
    while (this._queue.length > 0) {
      const slot = this._acquireIdleSlot();
      if (!slot) break;
      const job = this._takeBest();
      if (!job) break;
      this._dispatch(slot, job);
    }
    // Nothing can drain the queue: no live worker, and no slot left that could
    // produce one. Fail everything rather than let the scheduler's nodes sit
    // in 'loading' forever waiting on a promise that will never settle.
    if (this._queue.length > 0 && this.liveWorkerCount === 0) {
      this._failPool();
    }
  }

  /**
   * The next job to run: HIGHEST value, ties broken by enqueue order.
   *
   * A bounded linear scan, not a heap. The queue is capped at
   * `maxQueueDepth` (64 by default) and in practice holds a handful of entries,
   * so a scan costs less than maintaining heap invariants and adds no
   * dependency. With no caller supplying a value every entry scores 0 and the
   * first (oldest) entry always wins — the selection is then exactly FIFO.
   */
  private _takeBest(): PoolJob<T> | undefined {
    if (this._queue.length === 0) return undefined;
    let bestIndex = 0;
    for (let i = 1; i < this._queue.length; i++) {
      const candidate = this._queue[i];
      const best = this._queue[bestIndex];
      if (
        candidate.value > best.value ||
        (candidate.value === best.value && candidate.seq < best.seq)
      ) {
        bestIndex = i;
      }
    }
    return this._queue.splice(bestIndex, 1)[0];
  }

  /**
   * An idle worker, growing the pool on demand. Returns null when every slot is
   * busy, retired, or unable to produce a worker.
   */
  private _acquireIdleSlot(): PoolSlot<T> | null {
    for (const slot of this._slots) {
      if (slot.worker && !slot.job && !slot.retired) return slot;
    }
    // No warm worker free — grow. A slot that cannot build one is retired
    // rather than retried on every pump: worker construction failing is a
    // property of the environment, not a transient.
    for (const slot of this._slots) {
      if (slot.worker || slot.retired) continue;
      const worker = this._trySpawn(slot);
      if (worker) return slot;
      slot.retired = true;
    }
    return null;
  }

  /** Build a worker for a slot and wire its message/error handlers. */
  private _spawn(slot: PoolSlot<T>): WorkerLike {
    const worker = this._createWorker();
    worker.onmessage = (event: MessageEvent): void => {
      this._onMessage(slot, worker, event.data as PoolReply<T>);
    };
    worker.onerror = (): void => {
      this._onWorkerError(slot, worker);
    };
    return worker;
  }

  /** {@link _spawn}, but a construction failure returns null instead of throwing. */
  private _trySpawn(slot: PoolSlot<T>): WorkerLike | null {
    try {
      const worker = this._spawn(slot);
      slot.worker = worker;
      return worker;
    } catch {
      // Construction failed (resource limits, a blocked worker URL). The pool
      // carries on with whatever workers it already has — one is enough.
      return null;
    }
  }

  /** Post a job to a slot's worker, transferring its buffers exactly once. */
  private _dispatch(slot: PoolSlot<T>, job: PoolJob<T>): void {
    const worker = slot.worker;
    if (!worker) return; // unreachable: _acquireIdleSlot only returns live slots
    slot.job = job;
    job.slot = slot.index;
    job.dispatchedAt = this._now();
    const waited = job.dispatchedAt - job.enqueuedAt;
    this._queueWaitMs += waited;
    this.onQueueWaitMs?.(waited);
    this._dispatched++;
    // Ownership handover. Nulling first means that even if postMessage throws
    // mid-transfer, nothing downstream can find a list to transfer again.
    const transfer = job.transfer;
    job.transfer = null;
    try {
      // Protocol fields are written LAST so a payload can never shadow them —
      // a `type` or `requestId` key slipping in from a client would otherwise
      // silently mis-route or drop the reply.
      worker.postMessage(
        { ...job.payload, type: 'decode', requestId: job.requestId },
        transfer ? [...transfer] : [],
      );
    } catch (err) {
      // A synchronous post failure (DataCloneError on an already-detached
      // buffer, or a worker that died between the idle check and the post)
      // would otherwise strand this job in `_jobs` with its abort listener
      // attached. Settle it and surface the error. The job is NOT retried on
      // another worker: its buffers may already be detached, and a second
      // transfer of a detached buffer is exactly the bug this pool must not
      // have. The slot itself stays healthy — a clone failure says nothing
      // about the worker.
      slot.job = null;
      this._settle(job.requestId);
      job.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** A reply from `slot`'s worker. */
  private _onMessage(slot: PoolSlot<T>, worker: WorkerLike, reply: PoolReply<T>): void {
    // A reply from a worker this slot has already replaced (a late message from
    // a corpse) must not free the slot its successor is using.
    if (slot.worker !== worker) return;
    // Free the worker only for the job it was actually running. A duplicate or
    // unknown request id must never release a slot that has since been given a
    // different job — that is how two live decodes would end up on one worker.
    if (slot.job?.requestId === reply.requestId) slot.job = null;

    const job = this._settle(reply.requestId);
    if (!job) {
      // Cancelled, already settled, or an id this pool never issued. Drop the
      // result; the worker (if this freed it) is still good for more work.
      this._pump();
      return;
    }
    if (reply.type === 'decoded') {
      const active = this._now() - job.dispatchedAt;
      this._activeMs += active;
      this.onDecodeMs?.(active);
      job.resolve(reply.decoded);
    } else {
      job.reject(new Error(reply.error));
    }
    this._pump();
  }

  /**
   * A worker died. Reject only ITS job, then decide whether the slot comes
   * back.
   *
   * RESPAWN RULE. A slot is respawned only when another worker is still alive
   * and the slot has respawn budget left. The condition is the evidence test: a
   * death while siblings keep serving is demonstrably slot-local (a corrupt
   * WASM heap, an OOM on one large chunk), and a fresh worker is likely to
   * work. A death with no sibling alive is the single-worker case, where the
   * failure is just as likely to be systemic — respawning there risks a loop
   * that re-fails every decode while the scheduler's nodes sit in 'loading'.
   * The pool would rather report a hard failure the caller can surface.
   */
  private _onWorkerError(slot: PoolSlot<T>, worker: WorkerLike): void {
    if (slot.worker !== worker) return; // a stale error from a replaced worker
    const dying = slot.job;
    slot.job = null;
    slot.worker = null;
    try {
      worker.terminate();
    } catch {
      /* best-effort teardown — the worker is already dead */
    }

    const siblingAlive = this._slots.some((s) => s !== slot && s.worker !== null);
    if (siblingAlive && slot.respawnsLeft > 0) {
      slot.respawnsLeft--;
      this._respawns++;
      // Left un-retired: the next pump rebuilds it through `_acquireIdleSlot`,
      // so a pool that is not currently busy never pays for the respawn.
    } else {
      slot.retired = true;
    }

    // Its in-flight job cannot be rescheduled — the chunk buffer was
    // transferred into the worker that just died and is gone.
    if (dying) {
      this._settle(dying.requestId);
      dying.reject(new Error(this._messages.failed));
    }

    if (this.liveWorkerCount === 0 && !this._canGrow()) {
      this._failPool();
      return;
    }
    this._pump();
  }

  /** True when some slot could still produce a worker. */
  private _canGrow(): boolean {
    return this._slots.some((s) => !s.retired && !s.worker);
  }

  /**
   * The pool has no worker and no way to get one. Every queued request fails
   * and every later submit rejects at once, so a caller never waits on a
   * promise that cannot settle.
   */
  private _failPool(): void {
    if (this._broken) return;
    this._broken = true;
    this._failAll(new Error(this._messages.failed));
  }

  /** The caller's `AbortSignal` fired for `requestId`. */
  private _onAbort(requestId: number): void {
    const job = this._settle(requestId);
    if (!job) return; // already settled — the listener races a reply
    const slot = job.slot >= 0 ? this._slots[job.slot] : null;
    // Reject FIRST, then post the cancel best-effort. A worker dying in the
    // same tick as the abort makes postMessage throw, and if that ran before
    // the reject the promise would hang unsettled. The cancel only skips a
    // not-yet-started decode, so losing it to a dead worker costs nothing.
    job.reject(new Error(this._messages.aborted));
    if (!slot) {
      // Still queued: it never entered a worker, so there is nothing to cancel
      // and nothing was transferred. Drop it from the queue and release its
      // buffers to the collector.
      const at = this._queue.indexOf(job);
      if (at >= 0) this._queue.splice(at, 1);
      job.transfer = null;
      return;
    }
    // Active: the worker may be mid-WASM and cannot be interrupted, so the slot
    // stays busy until its reply arrives and is dropped. The cancel still helps
    // when the decode has not started yet.
    try {
      slot.worker?.postMessage({ type: 'cancel', requestId });
    } catch {
      /* worker already gone — the request is settled, the cancel is moot */
    }
  }

  /**
   * Remove a job from `_jobs` and detach its abort listener, returning it (or
   * undefined if it is already gone). The single teardown path, so a reply, an
   * abort, a sync post failure, a worker death and a fail-all all clean up
   * identically — no map entry and no signal listener is ever left behind.
   */
  private _settle(requestId: number): PoolJob<T> | undefined {
    const job = this._jobs.get(requestId);
    if (!job) return undefined;
    this._jobs.delete(requestId);
    if (job.onAbort && job.signal) {
      job.signal.removeEventListener('abort', job.onAbort);
      job.onAbort = undefined;
    }
    return job;
  }

  /**
   * Reject every unsettled request. Active jobs are included: their workers are
   * being torn down (dispose) or are already gone (pool failure), so no reply
   * is coming. Slots are not touched here — the callers do that.
   */
  private _failAll(error: Error): void {
    const jobs = [...this._jobs.values()];
    this._jobs.clear();
    this._queue.length = 0;
    for (const job of jobs) {
      if (job.onAbort && job.signal) {
        job.signal.removeEventListener('abort', job.onAbort);
        job.onAbort = undefined;
      }
      job.transfer = null;
      job.reject(error);
    }
  }
}

/** A monotonic millisecond clock, available on both the main thread and workers. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
