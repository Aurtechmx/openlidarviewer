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
  DEFAULT_STALE_MS,
} from '../src/io/heavy/opfsStoreJanitor';

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
