/**
 * oocCacheMap.ts — the persisted fingerprint → store map for the OOC cache.
 *
 * Phase 2 of the persistent out-of-core cache. A small JSON record in the OPFS
 * root records which promoted tile store holds the index for a given file
 * fingerprint (Phase 1), so a reopen can find it without rebuilding. Everything
 * here is deliberately small and defensive.
 *
 * Two rules the design turns on:
 *
 *   Fail closed. A missing, corrupt, or wrong-version record parses to an empty
 *   map, so the worst a bad file can do is force rebuilds — never a wrong hit. An
 *   individually malformed entry is dropped, not allowed to match.
 *
 *   Generation-gated. A lookup matches only when the cache generation matches
 *   too. The generation binds the tile-store schema and the fingerprint scheme,
 *   so an index written by an incompatible build is a miss even when the source
 *   file has not changed — the stored bytes describe a format this build can no
 *   longer read.
 *
 * The pure core (parse / serialize / lookup / upsert) is what the tests pin; the
 * OPFS bridge at the end is a thin read/write over the root directory.
 */

import { canonicalJson } from '../../canonicalHash';
import { TILE_STORE_SCHEMA_VERSION } from './tileStore';
import { FINGERPRINT_VERSION } from './fileFingerprint';
import { readOpfsText, writeOpfsText, type OpfsDirHandle } from './opfsSpillStore';
import { withCacheMapLock, type LockManagerLike } from './oocStoreLiveness';

/** Bumped when the map's own shape changes, so an old record parses to empty.
 *  v2 adds the authoritative `sourceContentSha256` to every entry. */
export const CACHE_MAP_VERSION = 2;

/**
 * Bumped when the SAME source bytes could decode to semantically different OOC
 * point content — a change in LAS/LAZ decode semantics, classification or
 * return-number interpretation, coordinate scaling, Extra Bytes handling,
 * invalid-point filtering, a CRS-relevant point transform, or which source
 * records are selected. It is NOT the application version: a UI-only release must
 * not invalidate every cached index. Bump it only when a reused index built by
 * an older build could now be scientifically wrong, and note the reason here.
 */
export const HEAVY_INGEST_SEMANTICS_VERSION = 1;

/** The map's file name in the OPFS root, beside the tile stores it points at. */
export const CACHE_MAP_FILE = 'ooc-cache-map.json';

/** One cached index: which store holds it, and the facts eviction/telemetry need. */
export interface OocCacheEntry {
  /** The quick locator (sampled fingerprint): finds a candidate, never authorises. */
  readonly fingerprint: string;
  /** The authoritative SHA-256 over the whole source stream: authorises reuse. */
  readonly sourceContentSha256: string;
  readonly storeName: string;
  readonly generation: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly pointCount: number;
  readonly tileBytes: number;
}

/** The persisted map: a version and a flat list of entries. */
export interface OocCacheMap {
  readonly version: number;
  readonly entries: readonly OocCacheEntry[];
}

/**
 * The current cache generation: an index is only reusable by a build whose
 * generation string matches the one it was written under. Binds the tile-store
 * schema and the fingerprint scheme, so bumping either invalidates old indices.
 */
export function cacheGeneration(): string {
  return `t${TILE_STORE_SCHEMA_VERSION}.f${FINGERPRINT_VERSION}.m${CACHE_MAP_VERSION}.i${HEAVY_INGEST_SEMANTICS_VERSION}`;
}

export function emptyCacheMap(): OocCacheMap {
  return { version: CACHE_MAP_VERSION, entries: [] };
}

/** Canonical JSON, so the same map always serialises to the same bytes. */
export function serializeCacheMap(map: OocCacheMap): string {
  return canonicalJson(map);
}

function validEntry(raw: unknown): OocCacheEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!str(e.fingerprint) || !str(e.sourceContentSha256) || !str(e.storeName) || !str(e.generation))
    return null;
  if (!num(e.createdAt) || !num(e.lastUsedAt) || !num(e.pointCount) || !num(e.tileBytes)) return null;
  return {
    fingerprint: e.fingerprint,
    sourceContentSha256: e.sourceContentSha256,
    storeName: e.storeName,
    generation: e.generation,
    createdAt: e.createdAt,
    lastUsedAt: e.lastUsedAt,
    pointCount: e.pointCount,
    tileBytes: e.tileBytes,
  };
}

/**
 * Parse a serialised map, failing closed. Invalid JSON, a non-object root, a
 * missing/mismatched version, or a non-array `entries` all yield an empty map;
 * individually malformed entries are dropped, keeping the valid ones.
 */
export function parseCacheMap(text: string): OocCacheMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyCacheMap();
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyCacheMap();
  const obj = raw as Record<string, unknown>;
  if (obj.version !== CACHE_MAP_VERSION || !Array.isArray(obj.entries)) return emptyCacheMap();
  const entries: OocCacheEntry[] = [];
  for (const e of obj.entries) {
    const valid = validEntry(e);
    if (valid) entries.push(valid);
  }
  return { version: CACHE_MAP_VERSION, entries };
}

/**
 * The CANDIDATE entry for a quick locator, only if its generation matches — else
 * null. A candidate is not yet a reuse authorisation: the caller must still
 * verify the source-content digest (see {@link verifiedEntry}). The locator is a
 * sampled fingerprint, so a file edited outside the sampled windows can match
 * here while being a different file.
 */
export function lookupEntry(map: OocCacheMap, fingerprint: string, generation: string): OocCacheEntry | null {
  return (
    map.entries.find((e) => e.fingerprint === fingerprint && e.generation === generation) ?? null
  );
}

/**
 * The entry that authorises reuse: it matches the quick locator AND the
 * generation AND the authoritative whole-file `sourceContentSha256`. A candidate
 * whose stored content digest differs from the one recomputed from the file is
 * NOT returned — that is the stale-source case a locator-only match would wrongly
 * accept. An empty recomputed digest (verification failed or was cancelled)
 * never authorises reuse.
 */
export function verifiedEntry(
  map: OocCacheMap,
  generation: string,
  sourceContentSha256: string,
): OocCacheEntry | null {
  if (!sourceContentSha256) return null;
  return (
    map.entries.find(
      (e) => e.generation === generation && e.sourceContentSha256 === sourceContentSha256,
    ) ?? null
  );
}

/** Add or replace the entry for its authoritative (sourceContentSha256,
 *  generation) pair. Immutable. Keyed on the content digest, not the sampled
 *  locator, so two distinct files that share a locator get distinct entries. */
export function upsertEntry(map: OocCacheMap, next: OocCacheEntry): OocCacheMap {
  const entries = map.entries.filter(
    (e) =>
      !(e.sourceContentSha256 === next.sourceContentSha256 && e.generation === next.generation),
  );
  entries.push(next);
  return { version: map.version, entries };
}

/** Bump `lastUsedAt` for the matching entry (for LRU eviction). Immutable. */
export function touchEntry(
  map: OocCacheMap,
  sourceContentSha256: string,
  generation: string,
  now: number,
): OocCacheMap {
  const entries = map.entries.map((e) =>
    e.sourceContentSha256 === sourceContentSha256 && e.generation === generation
      ? { ...e, lastUsedAt: now }
      : e,
  );
  return { version: map.version, entries };
}

/** Drop the entry pointing at a store that no longer exists. Immutable. */
export function removeByStoreName(map: OocCacheMap, storeName: string): OocCacheMap {
  return { version: map.version, entries: map.entries.filter((e) => e.storeName !== storeName) };
}

export interface EvictionBudget {
  /** Total tile bytes the retained stores may occupy. */
  readonly budgetBytes: number;
  /** Stores a tab currently has open — never evicted, whatever their age. */
  readonly liveNames: ReadonlySet<string>;
}

/**
 * The store names to evict so the retained stores fit the byte budget, oldest
 * use first. A live store is never chosen, even when it is the oldest and the
 * budget is blown — a store in use must not be deleted from under it, so an
 * over-budget cache of only-live stores evicts nothing and waits.
 */
export function selectEvictions(
  entries: readonly OocCacheEntry[],
  { budgetBytes, liveNames }: EvictionBudget,
): string[] {
  let total = entries.reduce((n, e) => n + e.tileBytes, 0);
  if (total <= budgetBytes) return [];
  const evict: string[] = [];
  const byOldest = [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  for (const entry of byOldest) {
    if (total <= budgetBytes) break;
    if (liveNames.has(entry.storeName)) continue;
    evict.push(entry.storeName);
    total -= entry.tileBytes;
  }
  return evict;
}

/**
 * Read the map from the OPFS root, failing closed: a missing file or any read
 * error yields an empty map rather than throwing.
 */
export async function readCacheMap(root: OpfsDirHandle): Promise<OocCacheMap> {
  try {
    return parseCacheMap(await readOpfsText(root, CACHE_MAP_FILE));
  } catch {
    return emptyCacheMap();
  }
}

/** Write the map to the OPFS root (atomic via the OPFS writable swap). */
export async function writeCacheMap(root: OpfsDirHandle, map: OocCacheMap): Promise<void> {
  await writeOpfsText(root, CACHE_MAP_FILE, serializeCacheMap(map));
}

/**
 * Atomically apply `mutate` to the persisted map: re-read INSIDE the lock, so
 * the write is based on what is on disk now rather than on a copy read before
 * the lock was taken. Callers that hold a map read from earlier must not pass it
 * in; that stale copy is what the lock exists to discard.
 */
export async function mutateCacheMap(
  locks: LockManagerLike | null,
  root: OpfsDirHandle,
  mutate: (current: OocCacheMap) => OocCacheMap | Promise<OocCacheMap>,
): Promise<void> {
  await withCacheMapLock(locks, async () => {
    const next = await mutate(await readCacheMap(root));
    await writeCacheMap(root, next);
  });
}
