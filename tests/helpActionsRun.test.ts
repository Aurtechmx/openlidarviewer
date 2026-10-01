/**
 * helpActionsRun.test.ts
 *
 * Every Help action runs its handler and tells the user what happened,
 * including when the chunk it needs fails to load. The chunks are stubbed, so
 * nothing here touches the clipboard, the cache or the recovery journal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const chunks = vi.hoisted(() => ({
  copy: vi.fn(),
  offlineSave: vi.fn(),
  offlineRemove: vi.fn(),
  clearJournal: vi.fn(() => Promise.resolve()),
  fail: false,
}));

vi.mock('../src/lazyChunks', () => ({
  loadCopyDiagnostics: () => (chunks.fail ? Promise.reject(new Error('chunk')) : Promise.resolve({ copyDiagnostics: chunks.copy })),
  loadOfflineCopy: () => (chunks.fail ? Promise.reject(new Error('chunk')) : Promise.resolve({ makeAvailableOffline: chunks.offlineSave, removeOfflineCopy: chunks.offlineRemove })),
  loadRecovery: () => (chunks.fail ? Promise.reject(new Error('chunk')) : Promise.resolve({ clearRecoveryJournal: chunks.clearJournal })),
}));

const recovery = vi.hoisted(() => ({ on: true }));
vi.mock('../src/app/recovery/recoveryStatus', () => ({
  recoveryEnabled: () => recovery.on,
  setRecoveryEnabled: (on: boolean) => { recovery.on = on; },
}));

import { contributeHelpActions } from '../src/app/actions/helpActions';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function actions(notify = vi.fn()) {
  const replay = vi.fn();
  const open = vi.fn();
  const list = contributeHelpActions({
    getTour: () => ({ replay } as never),
    ensureShortcutSheet: () => Promise.resolve({ open } as never),
    getViewer: () => null,
    notify,
  });
  const run = (id: string): void => list.find((a) => a.id === id)!.run();
  return { run, notify, replay, open };
}

afterEach(() => { chunks.fail = false; vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('Help actions', () => {
  it('replays the tour and opens the shortcut sheet', async () => {
    const a = actions();
    a.run('tour.replay');
    a.run('help.shortcuts');
    await settle();
    expect(a.replay).toHaveBeenCalledTimes(1);
    expect(a.open).toHaveBeenCalledTimes(1);
  });

  it('runs the diagnostics and offline handlers from their chunks', async () => {
    const a = actions();
    a.run('help.copy-diagnostics');
    a.run('help.offline-save');
    a.run('help.offline-remove');
    await settle();
    expect(chunks.copy).toHaveBeenCalledTimes(1);
    expect(chunks.offlineSave).toHaveBeenCalledTimes(1);
    expect(chunks.offlineRemove).toHaveBeenCalledTimes(1);
  });

  it('says so when a chunk fails to load', async () => {
    chunks.fail = true;
    const a = actions();
    for (const id of ['help.copy-diagnostics', 'help.offline-save', 'help.offline-remove', 'help.session-recovery-clear']) a.run(id);
    await settle();
    expect(a.notify.mock.calls.map((c) => c[0])).toEqual([
      'Could not load the diagnostics report. Nothing was changed. Reload the page and try again.',
      'Could not start the offline download. Reload the page and try again.',
      'Could not remove the offline copy. Reload the page and try again.',
      'Could not clear recovery data. Reload the page and try again.',
    ]);
  });

  it('turns recovery off and on, and clears its data', async () => {
    const a = actions();
    recovery.on = true;
    a.run('help.session-recovery');
    expect(recovery.on).toBe(false);
    a.run('help.session-recovery');
    expect(recovery.on).toBe(true);
    a.run('help.session-recovery-clear');
    await settle();
    expect(chunks.clearJournal).toHaveBeenCalledTimes(2);
    expect(a.notify.mock.calls.map((c) => c[0])).toEqual([
      'Session recovery is off. Work saved for recovery in this browser was deleted.',
      'Session recovery is on. It starts after the next page load.',
      'Recovery data in this browser was deleted.',
    ]);
  });

  it('opens the Session log through the shell, and says when nothing is logged yet', async () => {
    const doc = new EventTarget();
    vi.stubGlobal('document', doc);
    const a = actions();
    const on = (e: Event): void => (e as CustomEvent<{ respond(p: Promise<boolean>): void }>).detail.respond(Promise.reject(new Error('x')));
    doc.addEventListener('olv-session-log-open', on);
    a.run('help.session-log');
    await settle();
    expect(a.notify).toHaveBeenCalledWith('Nothing is logged yet. The session log starts with the first file you open.');
    vi.stubGlobal('document', undefined);
    a.run('help.session-log');
    await settle();
    expect(a.notify).toHaveBeenCalledTimes(2);
  });
});
