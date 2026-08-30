/**
 * oocStoreLiveness.test.ts — cross-tab liveness for the OOC cache.
 *
 * Phase 3 of the persistent out-of-core cache, and the safety prerequisite for a
 * stable store name. Today each open builds a randomly-named store, so two tabs
 * never collide; once a store name is stable and shared, eviction or a rebuild in
 * place must never touch a store another tab is using. This module answers "is
 * anyone using store X" over the Web Locks API: a tab holds a SHARED lock for as
 * long as it has a store open, and a check for an EXCLUSIVE lock (if available)
 * tells whether anyone still holds it.
 *
 * The functions take an injected lock manager (the Web Locks subset they use), so
 * the whole thing is tested in Node against a fake that models shared/exclusive
 * grants. The one rule that matters most is pinned here: when liveness cannot be
 * determined — no lock manager at all — a store reads as BUSY, so a missing API
 * can only ever prevent an eviction, never cause a wrong one.
 */
import { describe, it, expect } from 'vitest';
import {
  storeLockName,
  acquireStoreResidency,
  isStoreBusy,
  liveStoreNames,
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

describe('oocStoreLiveness', () => {
  it('namespaces the lock name and includes the store name', () => {
    const a = storeLockName('ooc-scan-1');
    const b = storeLockName('ooc-scan-2');
    expect(a).toContain('ooc-scan-1');
    expect(a).not.toBe(b);
  });

  it('a store with no holder is not busy', async () => {
    expect(await isStoreBusy(fakeLocks(), 'store-1')).toBe(false);
  });

  it('residency makes a store busy until it is released', async () => {
    const locks = fakeLocks();
    const release = await acquireStoreResidency(locks, 'store-1');
    expect(await isStoreBusy(locks, 'store-1')).toBe(true);
    await release();
    expect(await isStoreBusy(locks, 'store-1')).toBe(false);
  });

  it('two tabs can hold the same store concurrently (shared), and it stays busy until both release', async () => {
    const locks = fakeLocks();
    const r1 = await acquireStoreResidency(locks, 'store-1');
    const r2 = await acquireStoreResidency(locks, 'store-1');
    expect(await isStoreBusy(locks, 'store-1')).toBe(true);
    await r1();
    expect(await isStoreBusy(locks, 'store-1')).toBe(true); // r2 still holds
    await r2();
    expect(await isStoreBusy(locks, 'store-1')).toBe(false);
  });

  it('fails safe: with no lock manager, a store reads as BUSY (never evictable)', async () => {
    expect(await isStoreBusy(null, 'store-1')).toBe(true);
  });

  it('liveStoreNames returns the currently-held store names and ignores foreign locks', async () => {
    const locks = fakeLocks();
    const r = await acquireStoreResidency(locks, 'store-A');
    // a lock that is not one of ours must not appear as a live store
    await locks.request('some-other-app-lock', { mode: 'shared' }, async () => {
      const live = await liveStoreNames(locks);
      expect(live).toEqual(new Set(['store-A']));
    });
    await r();
    expect(await liveStoreNames(locks)).toEqual(new Set());
  });

  it('liveStoreNames is null when liveness cannot be determined (no manager)', async () => {
    expect(await liveStoreNames(null)).toBeNull();
  });
});
