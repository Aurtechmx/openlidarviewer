/**
 * StreamingCache.ts
 *
 * A bounded, least-recently-used cache of *compressed* COPC node chunks. When
 * the camera revisits a region, a node that was evicted from the GPU can be
 * re-decoded from this cache instead of re-read from the file — and the cache
 * itself never grows past its byte budget, so it cannot leak.
 *
 * The cache holds the compressed bytes only; the decoded GPU buffers are
 * bounded separately by the scheduler's point budget and eviction.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

/** A byte-bounded LRU cache of compressed COPC node chunks. */
export class CompressedChunkCache {
  /** Insertion-ordered map — iteration front is the least-recently-used. */
  private readonly _entries = new Map<string, ArrayBuffer>();
  private readonly _maxBytes: number;
  private _bytes = 0;

  // Cumulative outcome counters — survive a `clear()` so a session-wide
  // streaming benchmark can report them. Reset only by `resetCounters()`.
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(maxBytes: number) {
    this._maxBytes = Math.max(0, maxBytes);
  }

  /**
   * Look up a cached chunk by node id. A hit moves the entry to most-recently
   * used. The returned buffer is the cache's own — callers that transfer it to
   * a worker must copy it first.
   */
  get(id: string): ArrayBuffer | undefined {
    const buffer = this._entries.get(id);
    if (buffer === undefined) {
      this._misses += 1;
      return undefined;
    }
    this._hits += 1;
    this._entries.delete(id);
    this._entries.set(id, buffer);
    return buffer;
  }

  /** Store a compressed chunk, evicting least-recently-used entries to fit. */
  put(id: string, bytes: ArrayBuffer): void {
    const existing = this._entries.get(id);
    if (existing) {
      this._bytes -= existing.byteLength;
      this._entries.delete(id);
    }
    // A chunk larger than the whole budget is simply not cached.
    if (bytes.byteLength > this._maxBytes) return;
    this._entries.set(id, bytes);
    this._bytes += bytes.byteLength;
    this._evictToFit();
  }

  /** Whether a node id is cached, without touching its recency. */
  has(id: string): boolean {
    return this._entries.has(id);
  }

  /**
   * Cache hysteresis (hysteresis). Bump a cached entry to most-recently-used
   * without returning it or counting it as a hit — the scheduler calls this
   * the moment a resident node is evicted, so the compressed chunk outlives
   * everything decoded before the eviction. A camera flick that pulls the
   * region back finds the chunk warm and skips the network/disk read.
   *
   * Returns `true` if the id was present and bumped, `false` if absent.
   */
  touch(id: string): boolean {
    const buffer = this._entries.get(id);
    if (buffer === undefined) return false;
    this._entries.delete(id);
    this._entries.set(id, buffer);
    return true;
  }

  /** Drop every cached chunk. */
  clear(): void {
    this._entries.clear();
    this._bytes = 0;
  }

  /** Bytes currently held. */
  get byteSize(): number {
    return this._bytes;
  }

  /** Number of cached chunks. */
  get count(): number {
    return this._entries.size;
  }

  /** The configured byte budget. */
  get maxBytes(): number {
    return this._maxBytes;
  }

  /** Cumulative hits since construction or the last `resetCounters()`. */
  get hits(): number {
    return this._hits;
  }

  /** Cumulative misses since construction or the last `resetCounters()`. */
  get misses(): number {
    return this._misses;
  }

  /**
   * Cumulative entries evicted by the byte-budget LRU since construction or
   * the last `resetCounters()`. A `clear()` does NOT touch this counter.
   */
  get evictions(): number {
    return this._evictions;
  }

  /** Zero the outcome counters — for a fresh benchmark window. */
  resetCounters(): void {
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  private _evictToFit(): void {
    while (this._bytes > this._maxBytes && this._entries.size > 0) {
      const oldest = this._entries.keys().next().value as string;
      const buffer = this._entries.get(oldest);
      if (buffer) this._bytes -= buffer.byteLength;
      this._entries.delete(oldest);
      this._evictions += 1;
    }
  }
}
