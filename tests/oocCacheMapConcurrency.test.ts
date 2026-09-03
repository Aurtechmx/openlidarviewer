import { describe, it, expect } from 'vitest';
import {
  emptyCacheMap,
  mutateCacheMap,
  readCacheMap,
  upsertEntry,
  writeCacheMap,
} from '../src/io/heavy/oocCacheMap';
import { withCacheMapLock, type LockManagerLike } from '../src/io/heavy/oocStoreLiveness';
import { fakeOpfsDir } from './support/fakeOpfs';

/**
 * Two tabs promoting stores at the same time used to interleave as
 * read(M0) / read(M0) / write(M1) / write(M0+own): the first tab's entry
 * vanished from the map while its store stayed on disk, retained and
 * referenced by nothing.
 */

/** A Web Locks stand-in with real exclusive queuing, so interleaving is decided by the lock. */
function fakeLocks(): LockManagerLike {
  const chain = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, _o: unknown, cb: (l: { name: string } | null) => T | Promise<T>) {
      const prior = chain.get(name) ?? Promise.resolve();
      const run = prior.then(() => cb({ name }));
      chain.set(name, run.catch(() => undefined));
      return run as Promise<T>;
    },
    query: () => Promise.resolve({ held: [] }),
  };
}

const entry = (storeName: string) => ({
  fingerprint: `fp-${storeName}`,
  sourceContentSha256: `sha-${storeName}`,
  storeName,
  generation: 'g1',
  createdAt: 1,
  lastUsedAt: 1,
  pointCount: 10,
  tileBytes: 100,
});

/** Read, yield to the microtask queue, then write — the interleaving window. */
async function unguardedUpsert(dir: ReturnType<typeof fakeOpfsDir>, name: string): Promise<void> {
  const map = await readCacheMap(dir);
  await Promise.resolve();
  await writeCacheMap(dir, upsertEntry(map, entry(name)));
}

describe('cache-map concurrent mutation', () => {
  it('loses an entry when two writers interleave unguarded', async () => {
    const dir = fakeOpfsDir();
    await writeCacheMap(dir, emptyCacheMap());
    await Promise.all([unguardedUpsert(dir, 'store-a'), unguardedUpsert(dir, 'store-b')]);
    const names = (await readCacheMap(dir)).entries.map((e) => e.storeName);
    // The bug, pinned: one of the two writes is gone.
    expect(names.length).toBe(1);
  });

  it('keeps both entries when each write re-reads under the lock', async () => {
    const dir = fakeOpfsDir();
    const locks = fakeLocks();
    await writeCacheMap(dir, emptyCacheMap());
    await Promise.all([
      mutateCacheMap(locks, dir, async (m) => {
        await Promise.resolve();
        return upsertEntry(m, entry('store-a'));
      }),
      mutateCacheMap(locks, dir, async (m) => {
        await Promise.resolve();
        return upsertEntry(m, entry('store-b'));
      }),
    ]);
    const names = (await readCacheMap(dir)).entries.map((e) => e.storeName).sort();
    expect(names).toEqual(['store-a', 'store-b']);
  });

  it('runs the body unguarded when no lock manager exists, rather than refusing', async () => {
    const dir = fakeOpfsDir();
    await writeCacheMap(dir, emptyCacheMap());
    await mutateCacheMap(null, dir, (m) => upsertEntry(m, entry('store-solo')));
    expect((await readCacheMap(dir)).entries.map((e) => e.storeName)).toEqual(['store-solo']);
  });

  it('serialises bodies under the same lock name', async () => {
    const locks = fakeLocks();
    const order: string[] = [];
    const body = (tag: string) => async () => {
      order.push(`${tag}:enter`);
      await Promise.resolve();
      order.push(`${tag}:exit`);
    };
    await Promise.all([withCacheMapLock(locks, body('a')), withCacheMapLock(locks, body('b'))]);
    expect(order).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit']);
  });
});
