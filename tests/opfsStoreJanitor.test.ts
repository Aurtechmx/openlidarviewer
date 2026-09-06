/**
 * opfsStoreJanitor.test.ts — the startup janitor removes an abandoned build
 * partial but keeps a promoted, fresh, or owned store (findings #16, #7).
 *
 * A crashed tab or a failed close-time removal leaves an `ooc-…` or
 * `<name>.partial` directory the size of the scan in OPFS. The janitor sweeps
 * ONLY `<name>.partial` stores, and only when it can PROVE one stale — a lease
 * older than the threshold — and a live session does not own it. A promoted
 * final `ooc-…` store is never swept even when its lease is old, because it may
 * be live data another tab still owns and there is no cross-tab ownership signal
 * yet. Anything younger, owned, or of unknown age is kept, because deleting a
 * store a running build still fills is the one failure this must never have.
 */
import { describe, it, expect } from 'vitest';
import { fakeOpfs } from './support/fakeOpfs';
import {
  writeOpfsText,
  STORE_LEASE_FILE,
  type OpfsDirHandle,
} from '../src/io/heavy/opfsSpillStore';
import {
  sweepAbandonedOocStores,
  sweepPromotedOrphans,
  selectOrphanPromoted,
  DEFAULT_STALE_MS,
} from '../src/io/heavy/opfsStoreJanitor';
import { storeLockName, type LockManagerLike } from '../src/io/heavy/oocStoreLiveness';

const NOW = 1_000_000_000_000;

async function makeStore(root: OpfsDirHandle, name: string, createdAt: number | null): Promise<void> {
  const dir = await root.getDirectoryHandle(name, { create: true });
  await writeOpfsText(dir, 'manifest.json', '{}');
  if (createdAt !== null) {
    await writeOpfsText(dir, STORE_LEASE_FILE, JSON.stringify({ createdAt }));
  }
}

describe('OOC startup janitor', () => {
  it('removes a stale abandoned partial, keeps promoted, fresh, owned, and unknown-age ones', async () => {
    const opfs = fakeOpfs();
    const stalePartial = 'ooc-abandoned.las-100-bbbb.partial';
    const stalePromoted = 'ooc-abandoned.las-100-aaaa';
    const fresh = 'ooc-recent.las-100-cccc.partial';
    const owned = 'ooc-live.las-100-dddd.partial';
    const unknown = 'ooc-nolease.las-100-eeee.partial';

    await makeStore(opfs.root, stalePartial, NOW - DEFAULT_STALE_MS - 60_000);
    // A PROMOTED final store older than the threshold: it may be a live dataset
    // another tab still owns, so the janitor must not touch it (finding #7).
    await makeStore(opfs.root, stalePromoted, NOW - DEFAULT_STALE_MS - 60_000);
    await makeStore(opfs.root, fresh, NOW - 60_000);
    await makeStore(opfs.root, owned, NOW - DEFAULT_STALE_MS - 60_000);
    await makeStore(opfs.root, unknown, null);
    // A non-temp directory the sweep must never touch.
    await opfs.root.getDirectoryHandle('some-other-thing', { create: true });

    const removed = await sweepAbandonedOocStores(opfs.root, {
      now: NOW,
      ownedNames: new Set([owned]),
    });

    expect(removed).toEqual([stalePartial]);
    const top = opfs.topLevel();
    expect(top).not.toContain(stalePartial);
    expect(top).toContain(stalePromoted);
    expect(top).toContain(fresh);
    expect(top).toContain(owned);
    expect(top).toContain(unknown);
    expect(top).toContain('some-other-thing');
  });

  it('never sweeps a promoted final store even when its lease is well past the threshold', async () => {
    const opfs = fakeOpfs();
    const promoted = 'ooc-huge.las-999-ffff';
    await makeStore(opfs.root, promoted, NOW - DEFAULT_STALE_MS * 10);
    const removed = await sweepAbandonedOocStores(opfs.root, { now: NOW });
    expect(removed).toEqual([]);
    expect(opfs.topLevel()).toContain(promoted);
  });

  it('removes nothing when every partial is younger than the threshold', async () => {
    const opfs = fakeOpfs();
    await makeStore(opfs.root, 'ooc-a.las-1-x.partial', NOW - 1000);
    await makeStore(opfs.root, 'ooc-b.las-1-y.partial', NOW - 1000);
    const removed = await sweepAbandonedOocStores(opfs.root, { now: NOW });
    expect(removed).toEqual([]);
    expect(opfs.topLevel()).toHaveLength(2);
  });
});

describe('selectOrphanPromoted', () => {
  const names = [
    'ooc-a-100-x',            // promoted, orphan
    'ooc-b-100-y',            // promoted, referenced
    'ooc-c-100-z',            // promoted, live
    'ooc-d-100-w.partial',    // a build partial — not promoted
    'ooc-cache-map.json',     // the map record — not a store
  ];
  const referenced = new Set(['ooc-b-100-y']);
  const live = new Set(['ooc-c-100-z']);

  it('picks only promoted stores that are neither referenced nor live', () => {
    expect(selectOrphanPromoted(names, referenced, live)).toEqual(['ooc-a-100-x']);
  });

  it('never selects a partial or the cache-map file', () => {
    const got = selectOrphanPromoted(names, new Set(), new Set());
    expect(got).not.toContain('ooc-d-100-w.partial');
    expect(got).not.toContain('ooc-cache-map.json');
  });
});

/** A lock manager where nothing is held, so every exclusive request succeeds. */
function freeLocks(): LockManagerLike {
  return {
    async request(name, _options, cb) { return cb({ name }); },
    async query() { return { held: [] }; },
  };
}

/** A lock manager where `busy` names stores a live tab already holds. */
function heldLocks(busy: ReadonlySet<string>): LockManagerLike {
  return {
    async request(name, options, cb) {
      const contended = [...busy].some((s) => storeLockName(s) === name);
      if (contended && options.ifAvailable) return cb(null);
      return cb({ name });
    },
    async query() { return { held: [...busy].map((name) => ({ name })) }; },
  };
}

describe('sweepPromotedOrphans', () => {
  it('removes a stale orphan, but keeps referenced, live, fresh, and unknown-age promoted stores', async () => {
    const opfs = fakeOpfs();
    await makeStore(opfs.root, 'ooc-orphan-100-a', NOW - DEFAULT_STALE_MS - 60_000); // stale orphan → sweep
    await makeStore(opfs.root, 'ooc-referenced-100-b', NOW - DEFAULT_STALE_MS - 60_000); // in map → keep
    await makeStore(opfs.root, 'ooc-live-100-c', NOW - DEFAULT_STALE_MS - 60_000); // held by a tab → keep
    await makeStore(opfs.root, 'ooc-fresh-100-d', NOW - 60_000); // just promoted → keep (race guard)
    await makeStore(opfs.root, 'ooc-nolease-100-e', null); // unknown age → keep

    const removed = await sweepPromotedOrphans(opfs.root, {
      referenced: new Set(['ooc-referenced-100-b']),
      live: new Set(['ooc-live-100-c']),
      locks: freeLocks(),
      now: NOW,
    });

    expect(removed).toEqual(['ooc-orphan-100-a']);
    expect(opfs.topLevel()).not.toContain('ooc-orphan-100-a');
    for (const kept of ['ooc-referenced-100-b', 'ooc-live-100-c', 'ooc-fresh-100-d', 'ooc-nolease-100-e']) {
      expect(opfs.topLevel()).toContain(kept);
    }
  });

  it('THE SNAPSHOT RACE: keeps a store a tab opened after `live` was sampled', async () => {
    // `live` is read once, before the sweep. A tab that opens a store after
    // that read is absent from the set, so on the snapshot alone this store
    // reads as a stale orphan and was deleted out from under a live reader.
    // Deleting under the store's own exclusive lock re-tests residency at the
    // moment of deletion, and the held shared lock refuses it.
    const opfs = fakeOpfs();
    await makeStore(opfs.root, 'ooc-latecomer-100-f', NOW - DEFAULT_STALE_MS - 60_000);
    const locks = heldLocks(new Set(['ooc-latecomer-100-f']));

    const removed = await sweepPromotedOrphans(opfs.root, {
      referenced: new Set(),
      live: new Set(), // the stale snapshot: the reader is not in it
      locks,
      now: NOW,
    });

    expect(removed).toEqual([]);
    expect(opfs.topLevel()).toContain('ooc-latecomer-100-f');
  });

  it('sweeps nothing at all without a lock manager', async () => {
    // Missing liveness must prevent destructive cleanup, never enable it.
    const opfs = fakeOpfs();
    await makeStore(opfs.root, 'ooc-orphan-100-g', NOW - DEFAULT_STALE_MS - 60_000);

    const removed = await sweepPromotedOrphans(opfs.root, {
      referenced: new Set(), live: new Set(), locks: null, now: NOW,
    });

    expect(removed).toEqual([]);
    expect(opfs.topLevel()).toContain('ooc-orphan-100-g');
  });
});
