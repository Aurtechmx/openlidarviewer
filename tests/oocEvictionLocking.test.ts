/**
 * Eviction must hold the store's own lock across the delete.
 *
 * The pass chose victims from a `liveStoreNames` snapshot and then deleted them
 * unlocked. That snapshot is taken under the cache-MAP lock, which is a
 * different lock from the store's residency lock, so a reader in another tab
 * could take shared residency in the gap and have the directory removed
 * underneath it. An `isStoreBusy` check first would not help either: its answer
 * is stale the moment it returns. The lock has to be HELD across the decision
 * and the removal.
 *
 * Two further rules are pinned here because both were wrong before:
 *   - a delete that FAILS must leave the cache-map entry alone, or the bytes
 *     stay on disk with nothing pointing at them;
 *   - with no lock manager, nothing is evicted — liveness is never guessed.
 */
import { describe, it, expect } from 'vitest';
import {
  storeLockName,
  acquireStoreResidency,
  removeStoreIfIdle,
  type LockManagerLike,
} from '../src/io/heavy/oocStoreLiveness';

/**
 * A fake Web Locks manager modelling shared/exclusive grants, ifAvailable, and
 * QUEUEING.
 *
 * The queue is the part that matters. An earlier fake consulted its grant rule
 * only under `ifAvailable` and handed a blocking request the lock immediately,
 * so a blocking exclusive request ran straight through a held shared lock. That
 * is the opposite of what Web Locks does, and it made every contention test
 * vacuous: the interleaving under test could not occur, because nothing ever
 * waited. A blocking request now parks until the lock is actually free.
 */
function fakeLocks(): LockManagerLike {
  const held = new Map<string, { shared: number; exclusive: boolean }>();
  const waiters: Array<() => void> = [];
  const canGrant = (name: string, mode: string): boolean => {
    const h = held.get(name);
    if (!h) return true;
    return mode === 'exclusive' ? h.shared === 0 && !h.exclusive : !h.exclusive;
  };
  /** Wake parked requests so each re-tests its own grant condition. */
  const pump = (): void => {
    const woken = waiters.splice(0, waiters.length);
    for (const w of woken) w();
  };
  return {
    async request(name, options, cb) {
      const mode = options.mode ?? 'exclusive';
      if (!canGrant(name, mode)) {
        // Non-blocking callers are told "busy" and never queue.
        if (options.ifAvailable) return cb(null);
        // Blocking callers wait for a release, then re-contend.
        while (!canGrant(name, mode)) {
          await new Promise<void>((r) => { waiters.push(r); });
        }
      }
      const h = held.get(name) ?? { shared: 0, exclusive: false };
      if (mode === 'exclusive') h.exclusive = true;
      else h.shared += 1;
      held.set(name, h);
      try {
        return await cb({ name });
      } finally {
        const g = held.get(name)!;
        if (mode === 'exclusive') g.exclusive = false;
        else g.shared -= 1;
        if (g.shared === 0 && !g.exclusive) held.delete(name);
        pump();
      }
    },
    async query() {
      return { held: [...held.keys()].map((name) => ({ name })) };
    },
  };
}

describe('removeStoreIfIdle', () => {
  it('deletes an idle store and reports it went', async () => {
    const locks = fakeLocks();
    const removed: string[] = [];
    const ok = await removeStoreIfIdle(locks, 'ooc-a', async (n) => { removed.push(n); });
    expect(ok).toBe(true);
    expect(removed).toEqual(['ooc-a']);
  });

  it('THE RACE: a reader holding residency keeps its store', async () => {
    const locks = fakeLocks();
    // Another tab has the store open — exactly the state the stale snapshot
    // could not see, because residency is a different lock from the map's.
    const release = await acquireStoreResidency(locks, 'ooc-a');
    const removed: string[] = [];
    const ok = await removeStoreIfIdle(locks, 'ooc-a', async (n) => { removed.push(n); });
    expect(ok, 'a live store was evicted').toBe(false);
    expect(removed, 'the delete ran anyway').toEqual([]);
    await release();
  });

  it('evicts the same store once the reader lets go', async () => {
    const locks = fakeLocks();
    const release = await acquireStoreResidency(locks, 'ooc-a');
    expect(await removeStoreIfIdle(locks, 'ooc-a', async () => {})).toBe(false);
    await release();
    expect(await removeStoreIfIdle(locks, 'ooc-a', async () => {})).toBe(true);
  });

  it('reports false when the delete fails, so the map keeps pointing at it', async () => {
    const locks = fakeLocks();
    const ok = await removeStoreIfIdle(locks, 'ooc-a', async () => {
      throw new Error('OPFS removal failed');
    });
    expect(ok).toBe(false);
  });

  it('evicts nothing without a lock manager, rather than guessing', async () => {
    const removed: string[] = [];
    const ok = await removeStoreIfIdle(null, 'ooc-a', async (n) => { removed.push(n); });
    expect(ok).toBe(false);
    expect(removed).toEqual([]);
  });

  it('releases the lock afterwards, so a later pass can still evict', async () => {
    const locks = fakeLocks();
    await removeStoreIfIdle(locks, 'ooc-a', async () => {});
    // If the exclusive grant leaked, this second attempt would read as busy.
    expect(await removeStoreIfIdle(locks, 'ooc-a', async () => {})).toBe(true);
  });

  it('releases the lock even when the delete threw', async () => {
    const locks = fakeLocks();
    await removeStoreIfIdle(locks, 'ooc-a', async () => { throw new Error('boom'); });
    expect(await removeStoreIfIdle(locks, 'ooc-a', async () => {})).toBe(true);
  });

  it('makes a BLOCKING exclusive request wait for a held shared lock', async () => {
    // The invariant `reopenFromCache` now relies on. It takes shared residency
    // BEFORE looking the directory up, so an evictor cannot delete the store
    // between the last read and the grant. That only holds if a conflicting
    // request genuinely waits, which is also what proves this fake is faithful
    // enough for the contention tests above to mean anything.
    const locks = fakeLocks();
    const order: string[] = [];
    let releaseReader = (): void => {};
    const readerDone = new Promise<void>((r) => { releaseReader = r; });
    const reader = locks.request('ooc-a', { mode: 'shared' }, async () => {
      order.push('reader-in');
      await readerDone;
      order.push('reader-out');
    });
    // Let the shared lock be taken before the exclusive request contends.
    await Promise.resolve();
    const evictor = locks.request('ooc-a', { mode: 'exclusive' }, async () => {
      order.push('evictor-in');
    });
    await Promise.resolve();
    expect(order).toEqual(['reader-in']);
    releaseReader();
    await Promise.all([reader, evictor]);
    expect(order).toEqual(['reader-in', 'reader-out', 'evictor-in']);
  });

  it('locks the store itself, not some other name', async () => {
    const locks = fakeLocks();
    const release = await acquireStoreResidency(locks, 'ooc-OTHER');
    // A reader on a DIFFERENT store must not protect this one.
    expect(await removeStoreIfIdle(locks, 'ooc-a', async () => {})).toBe(true);
    expect(storeLockName('ooc-a')).not.toBe(storeLockName('ooc-OTHER'));
    await release();
  });
});
