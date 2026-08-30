/**
 * oocCacheMap.test.ts — the persisted fingerprint → store map for the OOC cache.
 *
 * Phase 2 of the persistent out-of-core cache. A small JSON record in the OPFS
 * root maps a file fingerprint (Phase 1) to the promoted tile store that holds
 * its index. Two properties matter most and are pinned here: the map fails
 * CLOSED — a corrupt or wrong-version record reads as empty, so a bad map causes
 * rebuilds, never a wrong hit — and a lookup matches only when the cache
 * GENERATION matches too, so an index built by an incompatible tile format is a
 * miss even when the source file is unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  emptyCacheMap,
  serializeCacheMap,
  parseCacheMap,
  lookupEntry,
  upsertEntry,
  touchEntry,
  removeByStoreName,
  readCacheMap,
  writeCacheMap,
  cacheGeneration,
  CACHE_MAP_VERSION,
  type OocCacheEntry,
} from '../src/io/heavy/oocCacheMap';
import { fakeOpfsDir } from './support/fakeOpfs';

const GEN = 'gen-A';
const entry = (over: Partial<OocCacheEntry> = {}): OocCacheEntry => ({
  fingerprint: 'fp-1',
  storeName: 'ooc-abc-123',
  generation: GEN,
  createdAt: 1000,
  lastUsedAt: 1000,
  pointCount: 5_000_000,
  tileBytes: 135_000_000,
  ...over,
});

describe('oocCacheMap — pure core', () => {
  it('empty map carries the current version and no entries', () => {
    expect(emptyCacheMap()).toEqual({ version: CACHE_MAP_VERSION, entries: [] });
  });

  it('serialize → parse round-trips an entry', () => {
    const map = upsertEntry(emptyCacheMap(), entry());
    expect(parseCacheMap(serializeCacheMap(map))).toEqual(map);
  });

  it('fails closed to empty on invalid JSON, wrong shape, or wrong version', () => {
    expect(parseCacheMap('not json {')).toEqual(emptyCacheMap());
    expect(parseCacheMap('[]')).toEqual(emptyCacheMap());
    expect(parseCacheMap(JSON.stringify({ version: CACHE_MAP_VERSION + 99, entries: [] }))).toEqual(emptyCacheMap());
  });

  it('drops an individually-malformed entry but keeps the valid ones', () => {
    const good = entry();
    const raw = JSON.stringify({ version: CACHE_MAP_VERSION, entries: [good, { fingerprint: 5, storeName: null }] });
    const parsed = parseCacheMap(raw);
    expect(parsed.entries).toEqual([good]);
  });

  it('looks up only on matching fingerprint AND generation', () => {
    const map = upsertEntry(emptyCacheMap(), entry());
    expect(lookupEntry(map, 'fp-1', GEN)?.storeName).toBe('ooc-abc-123');
    expect(lookupEntry(map, 'fp-other', GEN)).toBeNull();
    // generation mismatch is a miss even though the fingerprint matches
    expect(lookupEntry(map, 'fp-1', 'gen-B')).toBeNull();
  });

  it('upsert replaces the entry for a (fingerprint, generation) pair without duplicating', () => {
    let map = upsertEntry(emptyCacheMap(), entry({ storeName: 'store-old' }));
    map = upsertEntry(map, entry({ storeName: 'store-new' }));
    expect(map.entries).toHaveLength(1);
    expect(lookupEntry(map, 'fp-1', GEN)?.storeName).toBe('store-new');
  });

  it('upsert is immutable — it does not mutate the input map', () => {
    const before = upsertEntry(emptyCacheMap(), entry());
    const snapshot = JSON.parse(JSON.stringify(before));
    upsertEntry(before, entry({ fingerprint: 'fp-2', storeName: 'store-2' }));
    expect(before).toEqual(snapshot);
  });

  it('touch updates lastUsedAt for the matching entry only', () => {
    let map = upsertEntry(emptyCacheMap(), entry({ fingerprint: 'fp-1', lastUsedAt: 1000 }));
    map = upsertEntry(map, entry({ fingerprint: 'fp-2', storeName: 'store-2', lastUsedAt: 1000 }));
    map = touchEntry(map, 'fp-1', GEN, 9999);
    expect(lookupEntry(map, 'fp-1', GEN)?.lastUsedAt).toBe(9999);
    expect(lookupEntry(map, 'fp-2', GEN)?.lastUsedAt).toBe(1000);
  });

  it('removeByStoreName drops the entry whose store was deleted out from under it', () => {
    const map = upsertEntry(emptyCacheMap(), entry());
    const after = removeByStoreName(map, 'ooc-abc-123');
    expect(lookupEntry(after, 'fp-1', GEN)).toBeNull();
  });

  it('cacheGeneration is a stable non-empty string', () => {
    expect(cacheGeneration()).toBe(cacheGeneration());
    expect(cacheGeneration().length).toBeGreaterThan(0);
  });
});

describe('oocCacheMap — OPFS bridge', () => {
  it('write then read round-trips the map through OPFS', async () => {
    const dir = fakeOpfsDir();
    const map = upsertEntry(emptyCacheMap(), entry());
    await writeCacheMap(dir, map);
    expect(await readCacheMap(dir)).toEqual(map);
  });

  it('reading a root with no map file returns an empty map (fail-closed)', async () => {
    expect(await readCacheMap(fakeOpfsDir())).toEqual(emptyCacheMap());
  });
});
