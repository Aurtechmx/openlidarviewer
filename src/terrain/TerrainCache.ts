/**
 * TerrainCache.ts
 *
 * In-memory cache of derived terrain results. Bounded by a memory
 * budget; evicts LRU when full. Keyed by a composite of dataset
 * fingerprint + tile id + analysis parameters + coverage mode +
 * point-count-hash, so different parameter sets get distinct
 * entries.
 *
 * Part of the foundation layer: an internal, feature-flag-gated seam for
 * foundation consumers. The live confidence-aware pipeline that powers the
 * Analyse panel manages its own results and does not read this cache.
 */

import type { TerrainAnalysisResult } from './TerrainContracts';

/** A composite key uniquely identifying one cache entry. */
export interface TerrainCacheKey {
  readonly datasetFingerprint: string;
  readonly tileId: number;
  readonly analysisParameters: string;
  readonly coverageMode: string;
  readonly pointCountHash: number;
}

/**
 * Build a stable string key from the composite. The separator is
 * `\x00` (NUL) rather than `|` so the key cannot collide on dataset
 * fingerprints, parameter JSON, or coverage labels that happen to
 * contain a literal pipe. NUL is allowed inside JS strings and
 * inside Map keys; it simply can't appear in any of these textual
 * sources in practice.
 */
const TERRAIN_CACHE_KEY_SEPARATOR = '\x00';

export function formatTerrainCacheKey(k: TerrainCacheKey): string {
  return [
    k.datasetFingerprint,
    k.tileId,
    k.analysisParameters,
    k.coverageMode,
    k.pointCountHash,
  ].join(TERRAIN_CACHE_KEY_SEPARATOR);
}

interface CacheEntry {
  readonly key: string;
  readonly result: TerrainAnalysisResult;
  /** Rough byte estimate — for memory-budget eviction. */
  readonly approxBytes: number;
}

/** Cache options. */
export interface TerrainCacheOptions {
  /** Memory budget in bytes. Default 64 MB. */
  readonly memoryBudgetBytes?: number;
  /**
   * Reserved for future use. Previously drove a wall-clock LRU
   * timestamp; the current implementation tracks recency via the
   * underlying `Map`'s insertion order so this hook is unused.
   * Kept on the options interface so existing callers don't break.
   */
  readonly now?: () => number;
}

/**
 * Per-entry overhead estimate in bytes. Each Map entry carries a
 * key string + value reference + internal hash-bucket bookkeeping
 * (~128 bytes empirically in V8 for short keys). Without this the
 * cache's reported byte total can underestimate the real RSS
 * footprint by a factor of 10 for a cache full of small results.
 */
const PER_ENTRY_OVERHEAD_BYTES = 128;

/** Approximate the byte size of one analysis result. */
function approxResultBytes(r: TerrainAnalysisResult): number {
  let bytes = 256 + PER_ENTRY_OVERHEAD_BYTES; // envelope + per-entry
  for (const arr of Object.values(r.payload)) bytes += (arr?.length ?? 0) * 8;
  for (const w of r.warnings) bytes += w.length * 2;
  return bytes;
}

/**
 * LRU cache for terrain analysis results. Pure data — no DOM.
 *
 * Recency tracking exploits the JS `Map` insertion-order invariant:
 * iteration always walks oldest-inserted first. We re-insert an
 * entry on `retrieve` to mark it as "most recently used", and the
 * evict path walks `entries()` in order until we're under budget.
 * That makes eviction O(k) for k evictions instead of O(n log n).
 */
export class TerrainCache {
  private readonly _entries = new Map<string, CacheEntry>();
  private _bytes = 0;
  private readonly _budget: number;

  constructor(opts: TerrainCacheOptions = {}) {
    this._budget = opts.memoryBudgetBytes ?? 64 * 1024 * 1024;
  }

  /** Insert or replace an entry. Marks it as most-recently-used. */
  insert(key: TerrainCacheKey, result: TerrainAnalysisResult): void {
    const k = formatTerrainCacheKey(key);
    const bytes = approxResultBytes(result);
    const existing = this._entries.get(k);
    if (existing) {
      this._bytes -= existing.approxBytes;
      this._entries.delete(k);
    }
    // Re-insertion places the entry at the end of the Map's
    // iteration order, making it the most recently used.
    this._entries.set(k, { key: k, result, approxBytes: bytes });
    this._bytes += bytes;
    this._evictToBudget();
  }

  /** Retrieve an entry; promotes it to most-recently-used on hit. */
  retrieve(key: TerrainCacheKey): TerrainAnalysisResult | undefined {
    const k = formatTerrainCacheKey(key);
    const entry = this._entries.get(k);
    if (!entry) return undefined;
    // Touch — delete + re-insert keeps byte total constant but
    // moves the entry to the end of the insertion-order chain so
    // the eviction pass picks older entries first.
    this._entries.delete(k);
    this._entries.set(k, entry);
    return entry.result;
  }

  /** Invalidate one entry. */
  invalidate(key: TerrainCacheKey): void {
    const k = formatTerrainCacheKey(key);
    const e = this._entries.get(k);
    if (!e) return;
    this._bytes -= e.approxBytes;
    this._entries.delete(k);
  }

  /** Clear every entry for a dataset. */
  clearDataset(datasetFingerprint: string): void {
    const prefix = `${datasetFingerprint}${TERRAIN_CACHE_KEY_SEPARATOR}`;
    for (const [k, e] of this._entries) {
      if (k.startsWith(prefix)) {
        this._bytes -= e.approxBytes;
        this._entries.delete(k);
      }
    }
  }

  /** Clear every entry. */
  clearAll(): void {
    this._entries.clear();
    this._bytes = 0;
  }

  /** Current estimated byte size of all cached entries. */
  get sizeBytes(): number {
    return this._bytes;
  }

  /** Entry count. */
  get size(): number {
    return this._entries.size;
  }

  // ── private ────────────────────────────────────────────────────────

  /**
   * Evict oldest entries until we're back under budget. Map
   * iteration walks oldest-inserted first, so we just delete in
   * iteration order until the byte total fits.
   */
  private _evictToBudget(): void {
    if (this._bytes <= this._budget) return;
    for (const [k, e] of this._entries) {
      if (this._bytes <= this._budget) break;
      this._bytes -= e.approxBytes;
      this._entries.delete(k);
    }
  }
}
