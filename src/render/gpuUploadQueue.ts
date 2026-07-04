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
}

/** What one `process` pass did. */
export interface UploadProcessResult {
  readonly uploaded: number;
  readonly uploadedBytes: number;
  readonly discarded: number;
  readonly remaining: number;
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
  private _pendingBytes = 0;
  private readonly _maxPendingBytes: number;
  private readonly _now: () => number;

  constructor(opts: { maxPendingBytes?: number; now?: () => number } = {}) {
    this._maxPendingBytes =
      opts.maxPendingBytes !== undefined && opts.maxPendingBytes > 0
        ? opts.maxPendingBytes
        : Number.POSITIVE_INFINITY;
    this._now = opts.now ?? defaultNow;
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

  /** Queue a decoded payload for upload. */
  enqueue(item: UploadItem): void {
    this._items.push(item);
    this._pendingBytes += Math.max(0, item.estBytes);
  }

  /** Drop every pending item for a dataset (detach / replace). Returns the count dropped. */
  cancelDataset(datasetId: string): number {
    let dropped = 0;
    const keep: UploadItem[] = [];
    for (const it of this._items) {
      if (it.datasetId === datasetId) {
        this._pendingBytes -= Math.max(0, it.estBytes);
        dropped++;
      } else {
        keep.push(it);
      }
    }
    this._items = keep;
    if (this._pendingBytes < 0) this._pendingBytes = 0;
    return dropped;
  }

  private _isCurrent(it: UploadItem): boolean {
    const gen = this._generation.get(it.datasetId);
    return gen === undefined || gen === it.generationId;
  }

  /**
   * Upload pending items until `budgetMs` is spent or the queue drains. Stale
   * items (superseded generation) are discarded WITHOUT upload and do not count
   * against the budget. At least one current item always uploads per call, so a
   * tiny budget can never starve the queue. Items are processed in enqueue order
   * — the caller enqueues central / high-priority nodes first.
   */
  process(budgetMs: number): UploadProcessResult {
    const start = this._now();
    let uploaded = 0;
    let uploadedBytes = 0;
    let discarded = 0;
    let i = 0;
    for (; i < this._items.length; i++) {
      const it = this._items[i];
      if (!this._isCurrent(it)) {
        this._pendingBytes -= Math.max(0, it.estBytes);
        discarded++;
        continue; // stale discards are ~free — never stop the loop on them
      }
      // Budget gate: always allow the first upload, then stop once spent.
      if (uploaded > 0 && this._now() - start >= budgetMs) break;
      this._pendingBytes -= Math.max(0, it.estBytes);
      it.commit();
      uploaded++;
      uploadedBytes += Math.max(0, it.estBytes);
    }
    this._items = this._items.slice(i);
    if (this._pendingBytes < 0) this._pendingBytes = 0;
    return { uploaded, uploadedBytes, discarded, remaining: this._items.length };
  }
}
