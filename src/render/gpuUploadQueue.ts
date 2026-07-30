/**
 * gpuUploadQueue.ts
 *
 * The P7 time-budgeted GPU upload queue (program §P7). Streaming octree nodes
 * finish decoding on a worker and then must be uploaded to the GPU on the main
 * thread — creating buffers, setting attributes. Doing every ready node's upload
 * in one frame is the classic "big node lands → 30 ms main-thread stall → visible
 * hitch". This queue spends only a bounded time budget per frame on uploads, so a
 * backlog drains over several frames instead of one janky one.
 *
 * Framework-free by design: it never imports three. The caller hands each item a
 * `commit` closure that does the actual buffer upload; the queue only decides
 * WHEN (budget) and WHETHER (stale generation) to call it. That keeps the policy
 * unit-testable in Node with an injected clock, while the real GPU work stays in
 * the Viewer. When the streaming node-commit path consumes this (the staged P7
 * integration), add a `loadGpuUploadQueue` seam to `lazyChunks.ts` — register a
 * seam only once it has a caller, or the chunk-emission guard fails the build for
 * a chunk nothing imports.
 *
 * Staleness: each dataset has a current generation id. A node detached/replaced
 * (new scan, epoch swap, clip change) bumps the generation; items enqueued under
 * an older generation are DISCARDED before upload — never shown — which is the
 * program's "complete means displayed, and only the current generation displays".
 *
 * Three rules the queue owes its caller, each with its reasoning at the code
 * that implements it:
 *
 *  - Exactly one terminal outcome per accepted item, whatever `commit` does.
 *    A commit that throws is that item's failure, not the pass's: it is booked
 *    as `commit-failed`, removed once, and the pass keeps going. `process`
 *    returns a result and never throws, because it runs inside the render loop.
 *  - One pending item per (datasetId, generationId, id). A repeat of an
 *    identity already in line is refused and released immediately.
 *  - A soft per-frame budget is not a memory ceiling. `maxBytes` may be
 *    overshot by one item so the queue always progresses; `maxItemBytes` may
 *    not, and an item over it is refused with a reason instead of being forced
 *    through or left blocking the head of the queue.
 */

/** One pending GPU upload. `commit` performs the actual buffer upload, at most once. */
export interface UploadItem {
  /** Stable node id (for logging / dedup by the caller). */
  readonly id: string;
  /** The owning dataset — cancellation and generation are keyed on this. */
  readonly datasetId: string;
  /** The generation this payload was decoded under; stale if it no longer matches. */
  readonly generationId: number;
  /** Estimated GPU bytes, for the pending-bytes backpressure accounting. */
  readonly estBytes: number;
  /** The real upload. Called exactly once, only while still current and in budget. */
  readonly commit: () => void;
  /**
   * Release the decoded payload when the item will never be committed.
   *
   * A discarded item still holds its decoded chunk through `commit`'s closure,
   * so without this the bytes stay reachable until the caller happens to drop
   * its own reference. Called at most once, and never after a `commit` that
   * returned normally. A `commit` that THREW gets it, because that payload was
   * not handed to the renderer and nothing else will free it. A throw here is
   * swallowed: cleanup failing must not stop the queue draining.
   */
  readonly onDiscard?: (reason: UploadDiscardReason) => void;
}

/** Why an item was dropped without uploading. */
export type UploadDiscardReason =
  | 'stale-generation'
  | 'dataset-canceled'
  | 'queue-cleared'
  /** An identical (datasetId, generationId, id) was already pending. */
  | 'duplicate-item'
  /** `commit` threw; the payload never reached the renderer. */
  | 'commit-failed'
  /** Bigger than `maxItemBytes`, so no single upload can ever absorb it. */
  | 'oversized-item';

/**
 * What `enqueue` did with an item, and with the payload it carries.
 *
 * Ownership: an accepted item's payload belongs to the queue, which then owes
 * exactly one terminal outcome for it (`commit` returning normally, or one
 * `onDiscard` call). A refused item's payload is released by `enqueue` itself
 * before it returns, so a caller that ignores this value still cannot leak; the
 * value is here for callers that want to count or log the refusal.
 */
export type UploadEnqueueOutcome = 'accepted' | 'duplicate';

/** What one `process` pass did. */
export interface UploadProcessResult {
  /** Commits that returned normally. */
  readonly uploaded: number;
  readonly uploadedBytes: number;
  /** Everything removed without a completed upload: `stale + failed + oversized`. */
  readonly discarded: number;
  /** Subset of `discarded`: superseded generation, dropped before any commit. */
  readonly stale: number;
  /** Subset of `discarded`: `commit` threw. */
  readonly failed: number;
  /** Subset of `discarded`: refused for exceeding the hard per-item ceiling. */
  readonly oversized: number;
  readonly remaining: number;
  /** Which limit ended the pass, or `drained` when the queue emptied. */
  readonly stoppedBy: 'drained' | 'time' | 'bytes' | 'nodes';
}

/**
 * Per-frame commit limits. All three are SOFT: one item per pass may overshoot
 * them, because a queue that commits nothing never shows the scan. The hard
 * ceiling that no item may cross is `maxItemBytes` on the queue itself.
 *
 * Time alone is not enough. Three.js defers the real buffer upload to the next
 * render, so a pass can spend almost no CPU and still hand the GPU more than a
 * frame's worth of work. Bytes and node count bound what the *next* frame has
 * to absorb, which is the cost a user actually sees.
 */
export interface UploadLimits {
  readonly budgetMs: number;
  readonly maxBytes?: number;
  readonly maxNodes?: number;
}

/** Per-frame upload time budgets (ms). Desktop is roomier than mobile. */
export const DEFAULT_FRAME_BUDGET_MS = 4;
export const MOBILE_FRAME_BUDGET_MS = 2;
/** Never shrink the adaptive budget below this — one upload per frame must progress. */
export const MIN_FRAME_BUDGET_MS = 0.5;

/**
 * Shrink the per-frame upload budget under frame pressure: when the last frame
 * ran long (`frameMs` above `targetFrameMs`), spend proportionally less on
 * uploads so the queue never deepens a stall it is meant to prevent. Pure.
 */
export function adaptiveUploadBudgetMs(
  baseMs: number,
  frameMs: number,
  targetFrameMs = 1000 / 60,
): number {
  if (!(baseMs > 0)) return 0;
  if (!(frameMs > targetFrameMs) || !(targetFrameMs > 0)) return baseMs;
  const over = frameMs / targetFrameMs; // > 1 under pressure
  return Math.max(MIN_FRAME_BUDGET_MS, baseMs / over);
}

/** Default monotonic clock; overridable for deterministic tests. */
function defaultNow(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * A bounded, time-sliced upload queue. Not generic over three — the GPU work is
 * the caller's `commit` closure.
 */
export class GpuUploadQueue {
  private _items: UploadItem[] = [];
  private readonly _generation = new Map<string, number>();
  /** Identities currently in `_items`, so a repeat can be refused in O(1). */
  private readonly _live = new Set<string>();
  /** Bumped whenever a removal path replaces `_items`; see `process`. */
  private _revision = 0;
  private _pendingBytes = 0;
  private readonly _maxPendingBytes: number;
  private readonly _maxItemBytes: number;
  private readonly _now: () => number;
  private readonly _onCommitError:
    | ((error: unknown, item: UploadItem) => void)
    | undefined;

  constructor(
    opts: {
      maxPendingBytes?: number;
      /**
       * Hard per-item ceiling in estimated GPU bytes. Unlike `UploadLimits`,
       * this one is never overshot: it says what a single upload can absorb on
       * this device at all, so the per-frame progress bypass must not be able
       * to smuggle a larger item through. Absent means no ceiling, which is
       * today's behaviour and stays the default.
       */
      maxItemBytes?: number;
      now?: () => number;
      /**
       * Where a throwing `commit` is reported. The queue swallows the throw so
       * the render loop survives, and this is how the failure stops being
       * silent. A throw from the hook itself is swallowed too.
       */
      onCommitError?: (error: unknown, item: UploadItem) => void;
    } = {},
  ) {
    this._maxPendingBytes =
      opts.maxPendingBytes !== undefined && opts.maxPendingBytes > 0
        ? opts.maxPendingBytes
        : Number.POSITIVE_INFINITY;
    this._maxItemBytes =
      opts.maxItemBytes !== undefined && opts.maxItemBytes > 0
        ? opts.maxItemBytes
        : Number.POSITIVE_INFINITY;
    this._now = opts.now ?? defaultNow;
    this._onCommitError = opts.onCommitError;
  }

  /** Number of items waiting to upload. */
  get pendingCount(): number {
    return this._items.length;
  }

  /** Estimated GPU bytes waiting to upload — the backpressure signal. */
  get pendingBytes(): number {
    return this._pendingBytes;
  }

  /** Whether pending bytes have hit the backpressure ceiling (caller should pause decodes). */
  isSaturated(): boolean {
    return this._pendingBytes >= this._maxPendingBytes;
  }

  /** Register or advance a dataset's current generation; older items become stale. */
  setGeneration(datasetId: string, generationId: number): void {
    this._generation.set(datasetId, generationId);
  }

  /**
   * Queue a decoded payload for upload.
   *
   * Duplicate policy: the identity (datasetId, generationId, id) already in
   * line WINS, and the newcomer is refused. Two items with that identity are
   * the same node decoded twice under one generation, so their payloads are
   * interchangeable by construction and the queue has no basis for calling the
   * newer one better. Given that, keeping the earlier one is the cheaper and
   * more predictable half: enqueue order is the caller's priority order, so
   * replacing in place would let a node that keeps re-decoding keep resetting
   * its own turn, and swapping payloads would move already-accounted bytes
   * around for no visible difference. Refusing is also the only policy where
   * the byte accounting cannot drift, since nothing accepted is ever rewritten.
   *
   * The index holds only what is pending right now, not history: once an item
   * commits or is discarded its identity is free again, which is what an
   * evict-then-reload cycle needs.
   */
  enqueue(item: UploadItem): UploadEnqueueOutcome {
    const key = this._identity(item);
    if (this._live.has(key)) {
      // The loser is released here rather than left to the caller, so there is
      // exactly one release per payload no matter which side lost.
      this._discard(item, 'duplicate-item');
      return 'duplicate';
    }
    this._live.add(key);
    this._items.push(item);
    this._pendingBytes += Math.max(0, item.estBytes);
    return 'accepted';
  }

  /** Drop every pending item for a dataset (detach / replace). Returns the count dropped. */
  cancelDataset(datasetId: string): number {
    let dropped = 0;
    const keep: UploadItem[] = [];
    const released: UploadItem[] = [];
    for (const it of this._items) {
      // Not on the books means mid-commit: `process` removed its bytes and its
      // identity before handing it to caller code, and we are being re-entered
      // from that very commit. It is neither ours to release again nor ours to
      // keep, so it leaves without a second terminal outcome.
      if (!this._onBooks(it)) continue;
      if (it.datasetId === datasetId) {
        released.push(it);
        dropped++;
      } else {
        keep.push(it);
      }
    }
    this._items = keep;
    this._revision++;
    for (const it of released) this._release(it, 'dataset-canceled');
    return dropped;
  }

  /** Drop everything pending, releasing each payload. Returns the count dropped. */
  clear(): number {
    const items = this._items.filter((it) => this._onBooks(it));
    const dropped = items.length;
    // Emptied before the callbacks run: a cleanup hook that re-enters the queue
    // must not see items that are already accounted as gone.
    this._items = [];
    this._live.clear();
    this._pendingBytes = 0;
    this._revision++;
    for (const it of items) this._discard(it, 'queue-cleared');
    return dropped;
  }

  /**
   * The dedup key. NUL-joined because dataset ids are paths and node ids are
   * octree keys, either of which can contain a printable separator; a `:` join
   * could make two different identities collide into one.
   */
  private _identity(it: UploadItem): string {
    return `${it.datasetId}\u0000${it.generationId}\u0000${it.id}`;
  }

  /**
   * Whether the queue still owns this item's payload. False only for the single
   * item `process` has taken off the books and is committing right now, which is
   * how the removal paths avoid giving one payload two terminal outcomes when
   * caller code re-enters them from inside `commit`.
   */
  private _onBooks(it: UploadItem): boolean {
    return this._live.has(this._identity(it));
  }

  /** Take one item off the books (bytes + dedup index) and release its payload. */
  private _release(it: UploadItem, reason: UploadDiscardReason): void {
    this._pendingBytes -= Math.max(0, it.estBytes);
    if (this._pendingBytes < 0) this._pendingBytes = 0;
    this._live.delete(this._identity(it));
    this._discard(it, reason);
  }

  private _discard(it: UploadItem, reason: UploadDiscardReason): void {
    try {
      it.onDiscard?.(reason);
    } catch {
      /* Cleanup must never stop the queue draining. */
    }
  }

  private _reportCommitError(error: unknown, it: UploadItem): void {
    try {
      this._onCommitError?.(error, it);
    } catch {
      /* Diagnostics failing must not take down the pass that reported it. */
    }
  }

  private _isCurrent(it: UploadItem): boolean {
    const gen = this._generation.get(it.datasetId);
    return gen === undefined || gen === it.generationId;
  }

  /**
   * Upload pending items until `budgetMs` is spent or the queue drains. Stale
   * items (superseded generation) are discarded WITHOUT upload and do not count
   * against the budget. One item per call is offered to the GPU regardless of
   * the soft limits, so a tiny budget can never starve the queue. Items are
   * processed in enqueue order — the caller enqueues central / high-priority
   * nodes first.
   *
   * Never throws. Every item the loop reaches leaves the queue exactly once,
   * whether it uploaded, was stale, was refused as oversized, or threw from its
   * own `commit`, and the byte accounting is exact at every early exit.
   */
  process(limits: number | UploadLimits): UploadProcessResult {
    const { budgetMs, maxBytes, maxNodes } =
      typeof limits === 'number' ? { budgetMs: limits, maxBytes: undefined, maxNodes: undefined } : limits;
    const start = this._now();
    const revision = this._revision;
    let uploaded = 0;
    let uploadedBytes = 0;
    let stale = 0;
    let failed = 0;
    let oversized = 0;
    // Commit ATTEMPTS, not successes. See the bypass comment below.
    let attempted = 0;
    let stoppedBy: UploadProcessResult['stoppedBy'] = 'drained';
    let i = 0;
    for (; i < this._items.length; i++) {
      const it = this._items[i];
      // `commit` is caller code and can re-enter the queue (a detach mid-pass
      // calls clear()). Stop rather than read past a list that shrank under us;
      // the slice below still removes exactly the prefix already handled.
      if (it === undefined) break;
      if (!this._isCurrent(it)) {
        this._release(it, 'stale-generation');
        stale++;
        continue; // stale discards are ~free — never stop the loop on them
      }
      const bytes = Math.max(0, it.estBytes);
      // The hard ceiling, checked before any limit that the progress bypass can
      // waive. An item over it cannot be uploaded on this device at all, so
      // forcing it through would trade a stall for an out-of-memory abort, and
      // leaving it queued would park it at the head forever while the loop
      // re-reaches it every frame. Refuse it once, name the reason, keep going.
      if (bytes > this._maxItemBytes) {
        this._release(it, 'oversized-item');
        oversized++;
        continue;
      }
      // Soft limits. The first commit attempt of a pass is exempt, because a
      // per-frame budget smaller than one node would otherwise stall the queue
      // permanently and a stalled queue never shows the scan. Exempting the
      // first ATTEMPT rather than the first success is what keeps a run of
      // throwing items from walking the whole queue past its budget in one
      // frame: after one attempt, failed or not, the limits apply again.
      if (attempted > 0) {
        if (this._now() - start >= budgetMs) { stoppedBy = 'time'; break; }
        if (maxNodes !== undefined && uploaded >= maxNodes) { stoppedBy = 'nodes'; break; }
        if (maxBytes !== undefined && uploadedBytes + bytes > maxBytes) {
          stoppedBy = 'bytes';
          break;
        }
      }
      // Off the books BEFORE caller code runs: bytes subtracted and the
      // identity freed, so a throw below can leave the item neither charged as
      // pending nor eligible for a replay on the next pass.
      this._pendingBytes -= bytes;
      this._live.delete(this._identity(it));
      attempted++;
      try {
        it.commit();
        uploaded++;
        uploadedBytes += bytes;
      } catch (err) {
        // Policy: drop this item and CONTINUE the pass. A throw here is one
        // node's mesh failing to build, not a queue fault, so stopping would
        // punish every node queued behind it for one bad payload. Continuing is
        // safe against replay because the item is already removed. The pass
        // reports the failure in its result and through onCommitError; it does
        // not rethrow, because the caller is the render loop.
        failed++;
        this._discard(it, 'commit-failed');
        this._reportCommitError(err, it);
      }
    }
    // Only drop the handled prefix if the list is still the one we walked. A
    // `clear`/`cancelDataset` from inside a commit already rebuilt it, and
    // slicing that rebuilt list by our index would drop items nobody released.
    if (this._revision === revision) this._items = this._items.slice(i);
    if (this._pendingBytes < 0) this._pendingBytes = 0;
    return {
      uploaded,
      uploadedBytes,
      discarded: stale + failed + oversized,
      stale,
      failed,
      oversized,
      remaining: this._items.length,
      stoppedBy,
    };
  }

}
