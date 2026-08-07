/**
 * cancelledRequestSet.ts
 *
 * The set of request ids a decode worker has been told to skip, bounded so it
 * cannot grow without limit across a long session.
 *
 * The bound used to be `if (size > 256) clear()` — a full wipe. That is not an
 * eviction policy: a burst of more than 256 cancels (a fast camera sweep over a
 * dense cloud is exactly that) discarded EVERY id, including the ones whose
 * decodes had not started yet, so those decodes ran to completion and burned
 * WASM time on work the main thread had already given up on. The result was
 * still dropped client-side, so nothing rendered wrong — it just cost the one
 * resource a cancel exists to save.
 *
 * This evicts only the OLDEST entries instead. A JS `Set` iterates in insertion
 * order, so the first entry is always the oldest, and request ids are issued
 * monotonically — the oldest id is the one most likely to have been decoded or
 * dropped already. The newest cancels, which are the ones that can still stop
 * work from happening, are the ones kept.
 *
 * Worker-side and pure: no DOM, no WASM, no `Worker` — unit-tested in Node and
 * safe to import from a worker module.
 */

/**
 * Entries kept per worker. Sized against the streaming scheduler's working set
 * (a few hundred nodes in flight during a fast sweep) — large enough that a
 * cancel is still remembered when its decode comes up, small enough to be
 * irrelevant next to one laz-perf heap.
 */
export const DEFAULT_CANCELLED_CAPACITY = 256;

/** Bounded, insertion-ordered set of cancelled request ids. */
export class CancelledRequestSet {
  private readonly _ids = new Set<number>();
  private readonly _capacity: number;

  constructor(capacity: number = DEFAULT_CANCELLED_CAPACITY) {
    this._capacity = Math.max(1, Math.floor(capacity));
  }

  /** Remembered ids. Never exceeds the capacity. */
  get size(): number {
    return this._ids.size;
  }

  /** Mark a request cancelled, evicting the oldest ids if that overflows. */
  add(requestId: number): void {
    // Re-adding an existing id would keep its ORIGINAL insertion position, so
    // delete first: a repeated cancel then counts as fresh and is not the next
    // thing evicted.
    this._ids.delete(requestId);
    this._ids.add(requestId);
    while (this._ids.size > this._capacity) {
      const oldest = this._ids.values().next();
      if (oldest.done) break;
      this._ids.delete(oldest.value);
    }
  }

  /**
   * Was this request cancelled? Consumes the id when so — a request is only
   * ever asked about on its own decode path, so keeping it after the answer
   * would just hold a dead entry against the capacity.
   */
  consume(requestId: number): boolean {
    return this._ids.delete(requestId);
  }

  /** Is this request cancelled, without consuming it. */
  has(requestId: number): boolean {
    return this._ids.has(requestId);
  }
}
