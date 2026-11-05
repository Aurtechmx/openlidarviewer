/**
 * chunkFailureSurface.test.ts: what the user gets when a lazy chunk fails.
 * An open scan is never reloaded away, a raw module URL is never shown, and a
 * repeat failure says a reload is needed because a same-page retry cannot work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installChunkFailureNet,
  installStaleChunkRecovery,
  guardUserSave,
  chunkFailureText,
  reportChunkFailure,
  resetChunkFailuresForTests,
  setChunkFailureSurface,
  makeStaleWithWorkHandler,
  STALE_RELOAD_MARKER_KEY,
  STALE_RELOAD_NOTICE_KEY,
  consumeStaleReloadNotice,
  type StorageLike,
  chunkReloadAction,
} from '../src/app/staleChunkReload';
import { createLazySingleton, createLazySurfaceLoader, runWithRetry } from '../src/app/lazySurfaceLoad';
import { describeRemoteCopcError } from '../src/app/remoteSourceNaming';
import { settle } from '../src/ui/CommandPalette';
import { settleFileExport } from '../src/app/exportImageAction';

const URL_ERR = 'Failed to fetch dynamically imported module: http://localhost/assets/x-abc.js';
const chunkErr = (): Error => new TypeError(URL_ERR);
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function store(init: Record<string, string> = {}): StorageLike & { m: Map<string, string> } {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
}

beforeEach(() => { resetChunkFailuresForTests(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('a swept chunk with open work', () => {
  const setup = (open: boolean) => {
    const reload = vi.fn();
    const storage = store();
    const onStaleWithWork = vi.fn();
    const rec = installStaleChunkRecovery({ now: () => 1000, reload, storage, eventTarget: null, isOnline: () => true, probe: async () => 'missing', hasOpenWork: () => open, onStaleWithWork, log: () => {} });
    return { reload, storage, onStaleWithWork, rec };
  };

  it('does not reload, writes no marker, notifies once, and the import rejects', async () => {
    const { reload, storage, onStaleWithWork, rec } = setup(true);
    await expect(rec.importOrReload(() => Promise.reject(chunkErr()))).rejects.toThrow('dynamically');
    await expect(rec.importOrReload(() => Promise.reject(chunkErr()))).rejects.toThrow('dynamically');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.m.has(STALE_RELOAD_MARKER_KEY)).toBe(false);
    expect(onStaleWithWork).toHaveBeenCalledTimes(1);
  });

  it('a confirmed reload is not refused by the cooldown', async () => {
    const { reload, storage, onStaleWithWork, rec } = setup(true);
    storage.m.set(STALE_RELOAD_MARKER_KEY, '999');
    await expect(rec.importOrReload(() => Promise.reject(chunkErr()))).rejects.toThrow();
    onStaleWithWork.mock.calls[0][1].reload();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('with nothing open it still reloads, and leaves a notice for the next boot', async () => {
    const { reload, storage, onStaleWithWork, rec } = setup(false);
    void rec.importOrReload(() => Promise.reject(chunkErr()));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onStaleWithWork).not.toHaveBeenCalled();
    expect(storage.m.has(STALE_RELOAD_NOTICE_KEY)).toBe(true);
    expect(consumeStaleReloadNotice(storage)).toMatch(/updated/);
    expect(consumeStaleReloadNotice(storage)).toBeNull();
  });

  it('a throwing open-work check keeps the page', async () => {
    const reload = vi.fn();
    const rec = installStaleChunkRecovery({ now: () => 1, reload, storage: store(), eventTarget: null, isOnline: () => true, probe: async () => 'missing', hasOpenWork: () => { throw new Error('early'); }, onStaleWithWork: vi.fn(), log: () => {} });
    await expect(rec.importOrReload(() => Promise.reject(chunkErr()))).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  it('the notice offers only a reload, and it states the loss first', async () => {
    const showToast = vi.fn();
    const confirmReload = vi.fn(async () => false);
    const reload = vi.fn();
    makeStaleWithWorkHandler({ showToast, confirmReload })('new version', { reload });
    const action = showToast.mock.calls[0][1];
    expect(action.label).toBe('Reload…');
    action.onClick();
    await flush();
    expect(confirmReload).toHaveBeenCalledWith('Reload the page?', expect.stringContaining('discards'));
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the lazy surface toast', () => {
  const toast = () => { const calls: { m: string; a?: { label: string } }[] = []; return { calls, show: (m: string, a?: { label: string; onClick: () => void }) => { calls.push({ m, a }); } }; };

  it('never shows a module URL, keeps Try again first, then escalates to a reload', async () => {
    const t = toast();
    setChunkFailureSurface({ showToast: vi.fn(), confirmReload: async () => false, reload: vi.fn() });
    const run = createLazySurfaceLoader(t);
    await run(() => Promise.reject(chunkErr()), 'help', { retry: () => {} });
    expect(t.calls[0].m).toBe('The help could not load.');
    expect(t.calls[0].a?.label).toBe('Try again');
    await createLazySurfaceLoader(t)(() => Promise.reject(chunkErr()), 'help', { retry: () => {} });
    expect(t.calls[1].m).not.toContain('http');
    expect(t.calls[1].m).toMatch(/reload/i);
    expect(t.calls[1].a?.label).toBe('Reload…');
  });

  it('a success between failures starts over', async () => {
    const t = toast();
    const run = createLazySurfaceLoader(t);
    await run(() => Promise.reject(chunkErr()), 'help', { retry: () => {} });
    await run(() => Promise.resolve(1), 'help');
    await run(() => Promise.reject(chunkErr()), 'help', { retry: () => {} });
    expect(t.calls[1].a?.label).toBe('Try again');
  });

  it('an ordinary error keeps its own message and Try again', async () => {
    const t = toast();
    runWithRetry(t, () => Promise.reject(new Error('bad input')), 'x');
    runWithRetry(t, () => Promise.reject(new Error('bad input')), 'x');
    await flush();
    expect(t.calls.map((c) => [c.m, c.a?.label])).toEqual([['bad input', 'Try again'], ['bad input', 'Try again']]);
  });

  it('a singleton retry escalates too', async () => {
    const t = toast();
    const s = createLazySingleton(() => Promise.reject(chunkErr()), 'palette', t);
    await s.ensure();
    await s.ensure();
    expect(t.calls[1].m).toMatch(/reload/i);
  });
});

describe('the unhandled rejection net', () => {
  const target = () => {
    const ls: ((e: unknown) => void)[] = [];
    return { addEventListener: (_: string, l: (e: unknown) => void) => { ls.push(l); }, fire: (reason: unknown) => { const e = { reason, preventDefault: vi.fn() }; ls.forEach((l) => l(e)); return e; } };
  };

  it('shows one plain toast per burst, and does not claim the event', () => {
    const t = target();
    const show = vi.fn();
    let at = 0;
    installChunkFailureNet(t, show, () => at);
    const e = t.fire(chunkErr());
    t.fire(chunkErr());
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).not.toContain('http');
    expect(e.preventDefault).not.toHaveBeenCalled();
    at = 5000;
    t.fire(chunkErr());
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('ignores every other error', () => {
    const t = target();
    const show = vi.fn();
    installChunkFailureNet(t, show, () => 0);
    t.fire(new Error('boom'));
    t.fire(undefined);
    expect(show).not.toHaveBeenCalled();
  });

  it('stays quiet when a failure was already reported', () => {
    const t = target();
    const show = vi.fn();
    setChunkFailureSurface({ showToast: vi.fn(), confirmReload: async () => false, reload: vi.fn() }, () => 100);
    reportChunkFailure('This export');
    installChunkFailureNet(t, show, () => 200);
    t.fire(chunkErr());
    expect(show).not.toHaveBeenCalled();
  });
});

describe('Save session from a press', () => {
  it('says the session was not saved, and resolves false', async () => {
    const show = vi.fn();
    await expect(guardUserSave(() => Promise.reject(chunkErr()), show)()).resolves.toBe(false);
    expect(show.mock.calls[0][0]).toMatch(/^Session not saved/);
    expect(show.mock.calls[0][0]).not.toContain('http');
  });

  it('passes a result through, with no toast', async () => {
    const show = vi.fn();
    await expect(guardUserSave(() => Promise.resolve(true), show)()).resolves.toBe(true);
    expect(show).not.toHaveBeenCalled();
  });
});

describe('individual wording', () => {
  it('a URL open names the app, not the host', () => {
    const msg = describeRemoteCopcError(chunkErr(), 'https://example.com/a.copc.laz');
    expect(msg).not.toContain('was reached');
    expect(msg).not.toContain('http');
  });

  it('the failure text says what a reload costs', () => {
    expect(chunkFailureText('Plan view')).toMatch(/^Plan view could not load\. Reload the page.*closes open scans/);
  });

  it('a file export that lost its chunk shows no URL', async () => {
    const setError = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await settleFileExport(Promise.reject(chunkErr()), { setProgress: vi.fn(), setError });
    expect(setError.mock.calls[0][0]).not.toContain('http');
    expect(setError.mock.calls[0][0]).toMatch(/could not load/);
  });

  it('a palette command that loses its chunk is reported', async () => {
    const showToast = vi.fn();
    setChunkFailureSurface({ showToast, confirmReload: async () => false, reload: vi.fn() });
    settle(Promise.reject(chunkErr()));
    await flush();
    expect(showToast).toHaveBeenCalledTimes(1);
    settle(Promise.reject(new Error('other')));
    await flush();
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});

describe('a chunk failure while offline', () => {
  const offline = () => vi.stubGlobal('navigator', { onLine: false });
  afterEach(() => { vi.unstubAllGlobals(); resetChunkFailuresForTests(); });
  const surface = (showToast = vi.fn()) => setChunkFailureSurface({ showToast, confirmReload: async () => false, reload: vi.fn() });

  it('the offline note stops the net replacing it', () => {
    offline();
    const handlers: Array<(e: unknown) => void> = [];
    const show = vi.fn();
    installChunkFailureNet({ addEventListener: (_t, l) => { handlers.push(l); } }, show);
    const onOffline = vi.fn();
    const { importOrReload } = installStaleChunkRecovery({ onOffline, eventTarget: null, storage: null, probe: null, log: () => {} });
    return importOrReload(() => Promise.reject(chunkErr())).catch(() => {}).then(() => {
      expect(onOffline).toHaveBeenCalledTimes(1);
      handlers[0]({ reason: chunkErr() });
      expect(show).not.toHaveBeenCalled();
    });
  });

  it('the net itself says offline, with no reload', () => {
    offline();
    surface();
    const handlers: Array<(e: unknown) => void> = [];
    const show = vi.fn();
    installChunkFailureNet({ addEventListener: (_t, l) => { handlers.push(l); } }, show);
    handlers[0]({ reason: chunkErr() });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toMatch(/offline/i);
    expect(show.mock.calls[0][0]).not.toMatch(/reload/i);
    expect(show.mock.calls[0][1]).toBeUndefined();
  });

  it('no surface offers a reload', () => {
    offline();
    const showToast = vi.fn();
    surface(showToast);
    expect(chunkReloadAction()).toBeUndefined();
    expect(chunkFailureText('Plan view')).toBe('Plan view could not load. You are offline. Try again when back online.');
    reportChunkFailure('This export');
    expect(showToast.mock.calls[0][1]).toBeUndefined();
  });
});
