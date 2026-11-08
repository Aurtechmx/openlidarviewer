/**
 * offlineCopy.test.ts: the page side of the opt-in offline copy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeAvailableOffline, removeOfflineCopy, offlineOptInKey, type OfflineCopyEnv } from '../src/app/offlineCopy';
import { storageGet, storageRemove } from '../src/ui/safeStorage';

function fakeController(replies: object[]) {
  const sent: unknown[] = [];
  return {
    sent,
    controller: {
      postMessage(message: unknown, transfer: Transferable[]) {
        sent.push(message);
        const port = transfer[0] as MessagePort;
        for (const r of replies) port.postMessage(r);
      },
    },
  };
}

describe('offline copy actions', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    });
    storageRemove(offlineOptInKey());
  });

  it('says offline copies are unavailable when no worker controls the page', async () => {
    const msgs: string[] = [];
    const env: OfflineCopyEnv = { controller: null, fetchManifest: async () => ({ totalBytes: 1 }) };
    expect(await makeAvailableOffline((m) => msgs.push(m), env)).toBe(false);
    expect(await removeOfflineCopy((m) => msgs.push(m), env)).toBe(false);
    expect(msgs.every((m) => /not available here/.test(m))).toBe(true);
  });

  it('shows the size first, reports progress and completion, and records the choice', async () => {
    const msgs: string[] = [];
    const f = fakeController([
      { type: 'progress', done: 1, total: 4 },
      { type: 'progress', done: 2, total: 4 },
      { type: 'progress', done: 4, total: 4 },
      { type: 'done', total: 4, failed: 0 },
    ]);
    const ok = await makeAvailableOffline((m) => msgs.push(m), { controller: f.controller, fetchManifest: async () => ({ totalBytes: 7_500_000 }) });
    expect(ok).toBe(true);
    expect(f.sent).toEqual([{ type: 'olv-offline-save' }]);
    expect(msgs[0]).toBe('Downloading 7.5 MB so the app opens offline.');
    expect(msgs).toContain('Offline copy 50% downloaded.');
    expect(msgs.at(-1)).toBe('The app is available offline (7.5 MB).');
    expect(storageGet(offlineOptInKey())).toBe('1');
  });

  it('reports failure', async () => {
    const msgs: string[] = [];
    const f = fakeController([{ type: 'error' }]);
    expect(await makeAvailableOffline((m) => msgs.push(m), { controller: f.controller, fetchManifest: async () => ({ totalBytes: 1 }) })).toBe(false);
    expect(msgs.at(-1)).toMatch(/Could not make the app available offline/);
  });

  it('says the site changed during the save and the earlier copy is kept', async () => {
    const msgs: string[] = [];
    const f = fakeController([{ type: 'error', reason: 'build-mismatch' }]);
    expect(await makeAvailableOffline((m) => msgs.push(m), { controller: f.controller, fetchManifest: async () => ({ totalBytes: 1 }) })).toBe(false);
    expect(msgs.at(-1)).toMatch(/updated while saving.*earlier offline copy is kept/);
  });

  it('keys the choice by deployment path', () => {
    expect(offlineOptInKey('/a/')).toBe('olv.offline-copy@/a/');
    expect(offlineOptInKey('/a/index.html')).toBe('olv.offline-copy@/a/');
    expect(offlineOptInKey('/b/')).not.toBe(offlineOptInKey('/a/'));
    expect(offlineOptInKey('/')).toBe('olv.offline-copy@/');
  });

  it('remove posts the request and forgets the choice', async () => {
    const msgs: string[] = [];
    const f = fakeController([{ type: 'removed' }]);
    expect(await removeOfflineCopy((m) => msgs.push(m), { controller: f.controller, fetchManifest: async () => null })).toBe(true);
    expect(f.sent).toEqual([{ type: 'olv-offline-remove' }]);
    expect(msgs).toEqual(['Offline copy removed.']);
    expect(storageGet(offlineOptInKey())).toBeNull();
  });
});
