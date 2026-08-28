/**
 * opfsStoreJanitor.test.ts — the startup janitor removes an abandoned temp
 * store but keeps a fresh or owned one (finding #16).
 *
 * A crashed tab or a failed close-time removal leaves an `ooc-…` or
 * `<name>.partial` directory the size of the scan in OPFS. The janitor sweeps
 * one only when it can PROVE it stale — a lease older than the threshold — and
 * only when a live session does not own it. Anything younger, owned, or of
 * unknown age is kept, because deleting a store a running build still fills is
 * the one failure this must never have.
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
  it('removes a stale abandoned store, keeps fresh, owned, and unknown-age ones', async () => {
    const opfs = fakeOpfs();
    const stale = 'ooc-abandoned.las-100-aaaa';
    const stalePartial = 'ooc-abandoned.las-100-bbbb.partial';
    const fresh = 'ooc-recent.las-100-cccc';
    const owned = 'ooc-live.las-100-dddd';
    const unknown = 'ooc-nolease.las-100-eeee';

    await makeStore(opfs.root, stale, NOW - DEFAULT_STALE_MS - 60_000);
    await makeStore(opfs.root, stalePartial, NOW - DEFAULT_STALE_MS - 60_000);
    await makeStore(opfs.root, fresh, NOW - 60_000);
    await makeStore(opfs.root, owned, NOW - DEFAULT_STALE_MS - 60_000);
    await makeStore(opfs.root, unknown, null);
    // A non-temp directory the sweep must never touch.
    await opfs.root.getDirectoryHandle('some-other-thing', { create: true });

    const removed = await sweepAbandonedOocStores(opfs.root, {
      now: NOW,
      ownedNames: new Set([owned]),
    });

    expect(removed.sort()).toEqual([stale, stalePartial].sort());
    const top = opfs.topLevel();
    expect(top).not.toContain(stale);
    expect(top).not.toContain(stalePartial);
    expect(top).toContain(fresh);
    expect(top).toContain(owned);
    expect(top).toContain(unknown);
    expect(top).toContain('some-other-thing');
  });

  it('removes nothing when every store is younger than the threshold', async () => {
    const opfs = fakeOpfs();
    await makeStore(opfs.root, 'ooc-a.las-1-x', NOW - 1000);
    await makeStore(opfs.root, 'ooc-b.las-1-y.partial', NOW - 1000);
    const removed = await sweepAbandonedOocStores(opfs.root, { now: NOW });
    expect(removed).toEqual([]);
    expect(opfs.topLevel()).toHaveLength(2);
  });
});
