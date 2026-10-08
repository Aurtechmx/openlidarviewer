/**
 * staleChunkReload.test.ts — the stale-chunk recovery, driven with an injected
 * clock, storage, reload and event target so the whole decision is exercised in
 * Node without a real browser.
 *
 * Pins:
 *   - a single stale-chunk failure reloads exactly once, with no reload argument
 *     (so the current URL + query are preserved) and writes the cooldown marker;
 *   - a second stale-chunk failure inside the cooldown does NOT reload again —
 *     it surfaces the error (via onUnrecoverable, or by rejecting when none is
 *     wired) so the user is never trapped in a reload loop;
 *   - the cooldown expires (one reload per window, still never a loop within it);
 *   - an ordinary feature exception is not classified as stale and never reloads;
 *   - classifyLoadError matches the real browser / Vite phrasings only;
 *   - a `vite:preloadError` event drives the same guarded one-shot reload.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyLoadError,
  deferredPageReload,
  installStaleChunkRecovery,
  STALE_RELOAD_MARKER_KEY,
} from '../src/app/staleChunkReload';
import type { StorageLike, EventTargetLike } from '../src/app/staleChunkReload';

interface FakeStorage extends StorageLike {
  map: Map<string, string>;
}

function makeStorage(initial: Record<string, string> = {}): FakeStorage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

interface FakeTarget extends EventTargetLike {
  emit(type: string, event: unknown): void;
}

function makeTarget(): FakeTarget {
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    emit: (type, event) => {
      listeners.get(type)?.(event);
    },
  };
}

/** Flush the microtask queue so an async catch block has run to completion. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const staleError = () =>
  new Error('Failed to fetch dynamically imported module: /assets/panel-abc123.js');

describe('classifyLoadError', () => {
  it('classifies the real stale-chunk / preload phrasings as stale-chunk', () => {
    expect(
      classifyLoadError(new Error('Failed to fetch dynamically imported module: /a.js')),
    ).toBe('stale-chunk');
    expect(
      classifyLoadError(new Error('error loading dynamically imported module: /a.js')),
    ).toBe('stale-chunk');
    expect(classifyLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(
      'stale-chunk',
    );
    expect(classifyLoadError(new Error('unable to preload'))).toBe('stale-chunk');
    expect(classifyLoadError(new Error('importing a module script failed.'))).toBe(
      'stale-chunk',
    );
  });

  it('classifies a ChunkLoadError by its name', () => {
    const e = new Error('Loading chunk 12 failed');
    e.name = 'ChunkLoadError';
    expect(classifyLoadError(e)).toBe('stale-chunk');
  });

  it('unwraps a vite:preloadError event carrying its Error under .payload', () => {
    expect(
      classifyLoadError({ payload: new Error('Unable to preload CSS for /x.css') }),
    ).toBe('stale-chunk');
  });

  it('does NOT classify ordinary feature exceptions as stale', () => {
    expect(
      classifyLoadError(new Error('Cannot read properties of undefined (reading "x")')),
    ).toBe('other');
    expect(classifyLoadError(new TypeError('foo is not a function'))).toBe('other');
    expect(classifyLoadError(new Error('LAS public header is invalid'))).toBe('other');
    expect(classifyLoadError(null)).toBe('other');
    expect(classifyLoadError(undefined)).toBe('other');
  });
});

describe('installStaleChunkRecovery.importOrReload', () => {
  it('resolves with the loader value and never reloads on success', async () => {
    const reload = vi.fn();
    const recovery = installStaleChunkRecovery({
      reload,
      storage: makeStorage(),
      eventTarget: null,
      log: () => {},
    });
    await expect(recovery.importOrReload(async () => 42)).resolves.toBe(42);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads exactly once on a stale-chunk failure, with no reload arg (URL preserved) and writes the marker', async () => {
    const reload = vi.fn();
    const storage = makeStorage();
    const log = vi.fn();
    const recovery = installStaleChunkRecovery({
      now: () => 1000,
      reload,
      storage,
      eventTarget: null,
      log,
    });

    void recovery.importOrReload(() => Promise.reject(staleError()));
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
    // No argument → reload() re-requests the CURRENT URL + query.
    expect(reload).toHaveBeenCalledWith();
    expect(reload.mock.calls[0]).toEqual([]);
    expect(storage.map.get(STALE_RELOAD_MARKER_KEY)).toBe('1000');
    expect(log).toHaveBeenCalled();
  });

  it('does NOT reload a second time inside the cooldown — it surfaces via onUnrecoverable', async () => {
    const reload = vi.fn();
    const onUnrecoverable = vi.fn();
    // A reload was recorded 5 s ago; the clock is now 6000, inside the 20 s window.
    const storage = makeStorage({ [STALE_RELOAD_MARKER_KEY]: '1000' });
    const err = staleError();
    const recovery = installStaleChunkRecovery({
      now: () => 6000,
      cooldownMs: 20_000,
      reload,
      storage,
      eventTarget: null,
      onUnrecoverable,
      log: () => {},
    });

    void recovery.importOrReload(() => Promise.reject(err));
    await flush();

    expect(reload).not.toHaveBeenCalled();
    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
    expect(onUnrecoverable).toHaveBeenCalledWith(err);
    // Marker untouched — no second reload happened.
    expect(storage.map.get(STALE_RELOAD_MARKER_KEY)).toBe('1000');
  });

  it('rejects with the original error inside the cooldown when no onUnrecoverable is wired', async () => {
    const reload = vi.fn();
    const err = staleError();
    const recovery = installStaleChunkRecovery({
      now: () => 6000,
      cooldownMs: 20_000,
      reload,
      storage: makeStorage({ [STALE_RELOAD_MARKER_KEY]: '1000' }),
      eventTarget: null,
      log: () => {},
    });

    await expect(recovery.importOrReload(() => Promise.reject(err))).rejects.toBe(err);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again once the cooldown has fully expired (one reload per window, never a loop within it)', async () => {
    const reload = vi.fn();
    const storage = makeStorage({ [STALE_RELOAD_MARKER_KEY]: '1000' });
    // 20 s later exactly → the window has elapsed, so a reload is allowed again.
    const recovery = installStaleChunkRecovery({
      now: () => 21_000,
      cooldownMs: 20_000,
      reload,
      storage,
      eventTarget: null,
      log: () => {},
    });

    void recovery.importOrReload(() => Promise.reject(staleError()));
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.map.get(STALE_RELOAD_MARKER_KEY)).toBe('21000');
  });

  it('does not reload on an ordinary feature exception — it rejects with the original error', async () => {
    const reload = vi.fn();
    const storage = makeStorage();
    const featureErr = new Error('Cannot read properties of undefined (reading "bounds")');
    const recovery = installStaleChunkRecovery({
      now: () => 1000,
      reload,
      storage,
      eventTarget: null,
      log: () => {},
    });

    await expect(recovery.importOrReload(() => Promise.reject(featureErr))).rejects.toBe(
      featureErr,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(storage.map.has(STALE_RELOAD_MARKER_KEY)).toBe(false);
  });
});

describe('installStaleChunkRecovery vite:preloadError handler', () => {
  it('drives the same guarded one-shot reload from a vite:preloadError event', () => {
    const reload = vi.fn();
    const storage = makeStorage();
    const target = makeTarget();
    installStaleChunkRecovery({
      now: () => 5000,
      reload,
      storage,
      eventTarget: target,
      log: () => {},
    });

    const preventDefault = vi.fn();
    target.emit('vite:preloadError', {
      payload: new Error('Unable to preload CSS for /assets/x.css'),
      preventDefault,
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(storage.map.get(STALE_RELOAD_MARKER_KEY)).toBe('5000');
  });
});

/**
 * The installer registered a listener and handed back no way to remove it.
 * Every other teardown path here grew a disposer for the same reason: a
 * listener that outlives its owner keeps the closure alive, and installing
 * twice leaves two handlers, so one stale chunk recovers twice.
 */
describe('dispose', () => {
  function target() {
    const handlers: Array<(e: unknown) => void> = [];
    return {
      handlers,
      addEventListener: (_t: string, fn: (e: unknown) => void) => void handlers.push(fn),
      removeEventListener: (_t: string, fn: (e: unknown) => void) => {
        const i = handlers.indexOf(fn);
        if (i >= 0) handlers.splice(i, 1);
      },
    };
  }

  it('removes the listener it registered', () => {
    const t = target();
    const r = installStaleChunkRecovery({ eventTarget: t, reload: () => {} });
    expect(t.handlers).toHaveLength(1);
    r.dispose();
    expect(t.handlers).toHaveLength(0);
  });

  it('is safe to call twice', () => {
    const t = target();
    const r = installStaleChunkRecovery({ eventTarget: t, reload: () => {} });
    r.dispose();
    expect(() => r.dispose()).not.toThrow();
    expect(t.handlers).toHaveLength(0);
  });

  it('leaves no handler behind after install, dispose, install', () => {
    const t = target();
    installStaleChunkRecovery({ eventTarget: t, reload: () => {} }).dispose();
    installStaleChunkRecovery({ eventTarget: t, reload: () => {} });
    // Without dispose this would be 2, and one stale chunk would recover twice.
    expect(t.handlers).toHaveLength(1);
  });

  it('stays a no-op when the target cannot remove listeners', () => {
    const handlers: Array<(e: unknown) => void> = [];
    const addOnly = { addEventListener: (_t: string, fn: (e: unknown) => void) => void handlers.push(fn) };
    const r = installStaleChunkRecovery({ eventTarget: addOnly, reload: () => {} });
    expect(() => r.dispose()).not.toThrow();
  });
});

describe('deferredPageReload', () => {
  function fakeWindow() {
    const listeners: Record<string, Array<() => void>> = {};
    const timers: Array<() => void> = [];
    const win = {
      addEventListener: (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); },
      setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
      location: { reload: vi.fn() },
    };
    const fire = (type: string) => { for (const fn of listeners[type] ?? []) fn(); };
    const flush = () => { for (const fn of timers.splice(0)) fn(); };
    return { win, fire, flush };
  }

  it('reloads one task later, not synchronously', () => {
    const { win, flush } = fakeWindow();
    deferredPageReload(win)();
    expect(win.location.reload).not.toHaveBeenCalled();
    flush();
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it('drops the reload when the page is already leaving', () => {
    const { win, fire, flush } = fakeWindow();
    deferredPageReload(win)();
    fire('pagehide');
    flush();
    expect(win.location.reload).not.toHaveBeenCalled();
  });

  it('reloads again after a restore from the back-forward cache', () => {
    const { win, fire, flush } = fakeWindow();
    const reload = deferredPageReload(win);
    fire('pagehide');
    fire('pageshow');
    reload();
    flush();
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without a window', () => {
    expect(() => deferredPageReload(null)()).not.toThrow();
  });
});

describe('offline and network-blip chunk failures', () => {
  const chromiumErr = (): Error =>
    new TypeError('Failed to fetch dynamically imported module: https://olv.example/assets/findingsPanel-abc123.js');

  it('offline: a vite:preloadError neither reloads nor calls preventDefault, and reports the offline note', () => {
    const reload = vi.fn();
    const onOffline = vi.fn();
    const target = makeTarget();
    installStaleChunkRecovery({ reload, storage: makeStorage(), eventTarget: target, isOnline: () => false, onOffline, probe: null, log: () => {} });
    const preventDefault = vi.fn();
    target.emit('vite:preloadError', { payload: chromiumErr(), preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(onOffline).toHaveBeenCalledWith('You are offline, this part could not load. Try again when back online.');
  });

  it('offline: importOrReload rejects with the original error and does not reload or write the marker', async () => {
    const reload = vi.fn();
    const storage = makeStorage();
    const { importOrReload } = installStaleChunkRecovery({ reload, storage, eventTarget: null, isOnline: () => false, onOffline: () => {}, probe: null, log: () => {} });
    const err = chromiumErr();
    await expect(importOrReload(() => Promise.reject(err))).rejects.toBe(err);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.map.has(STALE_RELOAD_MARKER_KEY)).toBe(false);
  });

  it('online, chunk server unreachable: a network blip is not read as a deploy, so no reload and no preventDefault', async () => {
    const reload = vi.fn();
    const log = vi.fn();
    const probe = vi.fn(async () => 'unreachable' as const);
    const target = makeTarget();
    installStaleChunkRecovery({ reload, storage: makeStorage(), eventTarget: target, isOnline: () => true, probe, log });
    const preventDefault = vi.fn();
    target.emit('vite:preloadError', { payload: chromiumErr(), preventDefault });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('unreachable')));
    expect(probe).toHaveBeenCalledWith('https://olv.example/assets/findingsPanel-abc123.js');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('online, chunk still served: importOrReload rethrows instead of reloading', async () => {
    const reload = vi.fn();
    const { importOrReload } = installStaleChunkRecovery({ reload, storage: makeStorage(), eventTarget: null, isOnline: () => true, probe: async () => 'present', log: () => {} });
    const err = chromiumErr();
    await expect(importOrReload(() => Promise.reject(err))).rejects.toBe(err);
    expect(reload).not.toHaveBeenCalled();
  });

  it('online, chunk gone (404): the stale-deploy reload still happens once', async () => {
    const reload = vi.fn();
    const storage = makeStorage();
    const target = makeTarget();
    installStaleChunkRecovery({ reload, storage, eventTarget: target, isOnline: () => true, probe: async () => 'missing', log: () => {} });
    target.emit('vite:preloadError', { payload: chromiumErr(), preventDefault: () => {} });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(storage.map.has(STALE_RELOAD_MARKER_KEY)).toBe(true);
  });

  it('reads the chunk URL out of engine messages and ignores messages without one', async () => {
    const { chunkUrlFromError } = await import('../src/app/staleChunkReload');
    expect(chunkUrlFromError(chromiumErr())).toBe('https://olv.example/assets/findingsPanel-abc123.js');
    expect(chunkUrlFromError(new TypeError('error loading dynamically imported module: http://localhost:4173/assets/a-1.js?v=2'))).toBe('http://localhost:4173/assets/a-1.js');
    expect(chunkUrlFromError(new TypeError('Importing a module script failed.'))).toBeNull();
  });
});
