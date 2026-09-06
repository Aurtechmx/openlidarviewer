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

/** A fake Web Locks manager modelling shared/exclusive grants and ifAvailable. */
function fakeLocks(): LockManagerLike {
  const held = new Map<string, { shared: number; exclusive: boolean }>();
  const canGrant = (name: string, mode: string): boolean => {
    const h = held.get(name);
    if (!h) return true;
    return mode === 'exclusive' ? h.shared === 0 && !h.exclusive : !h.exclusive;
  };
  return {
    async request(name, options, cb) {
      const mode = options.mode ?? 'exclusive';
      if (options.ifAvailable && !canGrant(name, mode)) return cb(null);
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

  it('locks the store itself, not some other name', async () => {
    const locks = fakeLocks();
    const release = await acquireStoreResidency(locks, 'ooc-OTHER');
    // A reader on a DIFFERENT store must not protect this one.
    expect(await removeStoreIfIdle(locks, 'ooc-a', async () => {})).toBe(true);
    expect(storeLockName('ooc-a')).not.toBe(storeLockName('ooc-OTHER'));
    await release();
  });
});
