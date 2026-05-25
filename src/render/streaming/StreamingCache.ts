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
    if (buffer === undefined) return undefined;
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

  private _evictToFit(): void {
    while (this._bytes > this._maxBytes && this._entries.size > 0) {
      const oldest = this._entries.keys().next().value as string;
      const buffer = this._entries.get(oldest);
      if (buffer) this._bytes -= buffer.byteLength;
      this._entries.delete(oldest);
    }
  }
}
