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

/** Bumped when the map's own shape changes, so an old record parses to empty. */
export const CACHE_MAP_VERSION = 1;

/** The map's file name in the OPFS root, beside the tile stores it points at. */
export const CACHE_MAP_FILE = 'ooc-cache-map.json';

/** One cached index: which store holds it, and the facts eviction/telemetry need. */
export interface OocCacheEntry {
  readonly fingerprint: string;
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
  return `t${TILE_STORE_SCHEMA_VERSION}.f${FINGERPRINT_VERSION}.m${CACHE_MAP_VERSION}`;
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
  if (!str(e.fingerprint) || !str(e.storeName) || !str(e.generation)) return null;
  if (!num(e.createdAt) || !num(e.lastUsedAt) || !num(e.pointCount) || !num(e.tileBytes)) return null;
  return {
    fingerprint: e.fingerprint,
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

/** The entry for a fingerprint, only if its generation matches — else null. */
export function lookupEntry(map: OocCacheMap, fingerprint: string, generation: string): OocCacheEntry | null {
  return (
    map.entries.find((e) => e.fingerprint === fingerprint && e.generation === generation) ?? null
  );
}

/** Add or replace the entry for its (fingerprint, generation) pair. Immutable. */
export function upsertEntry(map: OocCacheMap, next: OocCacheEntry): OocCacheMap {
  const entries = map.entries.filter(
    (e) => !(e.fingerprint === next.fingerprint && e.generation === next.generation),
  );
  entries.push(next);
  return { version: map.version, entries };
}

/** Bump `lastUsedAt` for the matching entry (for LRU eviction later). Immutable. */
export function touchEntry(
  map: OocCacheMap,
  fingerprint: string,
  generation: string,
  now: number,
): OocCacheMap {
  const entries = map.entries.map((e) =>
    e.fingerprint === fingerprint && e.generation === generation ? { ...e, lastUsedAt: now } : e,
  );
  return { version: map.version, entries };
}

/** Drop the entry pointing at a store that no longer exists. Immutable. */
export function removeByStoreName(map: OocCacheMap, storeName: string): OocCacheMap {
  return { version: map.version, entries: map.entries.filter((e) => e.storeName !== storeName) };
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
