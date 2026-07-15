/**
 * swNavigationCache.test.ts
 *
 * The service worker's navigation handler is network-first with an offline
 * fallback to the cached './index.html' app shell. The original handler
 * cached EVERY same-origin navigation response under that one key — so
 * opening credits.html (linked from the viewer chrome, mode 'navigate'), or
 * landing on a 404/500 or redirected page, silently REPLACED the cached app
 * shell. The next offline load then rendered the wrong document as the app
 * (navigation cache-poisoning finding, Critical).
 *
 * public/sw.js is served verbatim (plain script, no exports), so these tests
 * evaluate its source inside a stubbed service-worker global scope — `self`
 * (capturing addEventListener), `caches`, and `fetch` — and drive the
 * captured 'fetch' listener with fake navigation FetchEvents. No DOM, no
 * real Cache API; the fakes model only what sw.js touches.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SW_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/sw.js'),
  'utf8',
);

/** The subset of a Response the worker's navigate branch reads. */
interface FakeResponse {
  readonly marker: string;
  readonly ok: boolean;
  readonly status: number;
  readonly redirected: boolean;
  readonly type: string;
  clone(): FakeResponse;
}

function res(marker: string, opts: Partial<FakeResponse> = {}): FakeResponse {
  const r: FakeResponse = {
    marker,
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    redirected: opts.redirected ?? false,
    type: opts.type ?? 'basic',
    clone: () => r,
  };
  return r;
}

/** In-memory stand-in for one named Cache. Keys are stored verbatim. */
class FakeCache {
  readonly store = new Map<string, FakeResponse>();
  addAll(keys: string[]): Promise<void> {
    for (const k of keys) this.store.set(k, res(`precached:${k}`));
    return Promise.resolve();
  }
  put(key: string | { url: string }, response: FakeResponse): Promise<void> {
    this.store.set(typeof key === 'string' ? key : key.url, response);
    return Promise.resolve();
  }
  match(key: string | { url: string }): Promise<FakeResponse | undefined> {
    return Promise.resolve(this.store.get(typeof key === 'string' ? key : key.url));
  }
}

/** CacheStorage stand-in — `match` searches every named cache, like the real one. */
class FakeCaches {
  readonly caches = new Map<string, FakeCache>();
  open(name: string): Promise<FakeCache> {
    let c = this.caches.get(name);
    if (!c) {
      c = new FakeCache();
      this.caches.set(name, c);
    }
    return Promise.resolve(c);
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.caches.keys()]);
  }
  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.caches.delete(name));
  }
  match(key: string): Promise<FakeResponse | undefined> {
    for (const c of this.caches.values()) {
      const hit = c.store.get(key);
      if (hit) return Promise.resolve(hit);
    }
    return Promise.resolve(undefined);
  }
}

interface Harness {
  /** Fire the captured 'fetch' listener with a navigation for `url`. */
  navigate(url: string): Promise<FakeResponse | undefined>;
  /** Fire the captured 'fetch' listener with a non-navigation GET for `url`. */
  asset(url: string, opts?: { range?: boolean; mode?: string }): Promise<FakeResponse | undefined>;
  /** Swap what the stubbed network returns (or rejects with, for offline). */
  setFetch(impl: (req: unknown) => Promise<FakeResponse>): void;
  /** The response currently cached under the app-shell key, if any. */
  cachedShell(): FakeResponse | undefined;
  /** The response currently cached under `key` in any cache, if any. */
  cached(key: string): FakeResponse | undefined;
}

/**
 * Evaluate public/sw.js in a stubbed SW scope, run its 'install' handler so
 * the shell is precached, and hand back a driver for navigation FetchEvents.
 */
async function bootWorker(scope = 'https://viewer.example/'): Promise<Harness> {
  const listeners = new Map<string, (event: unknown) => void>();
  const cachesObj = new FakeCaches();
  let fetchImpl: (req: unknown) => Promise<FakeResponse> = () =>
    Promise.reject(new Error('no fetch stub installed'));
  const origin = new URL(scope).origin;
  const selfObj = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.set(type, fn);
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    location: { origin, href: scope },
    registration: { scope },
  };
  // sw.js is a plain classic script referencing `self`, `caches`, and `fetch`
  // as globals — binding them as function parameters recreates its scope.
  new Function('self', 'caches', 'fetch', SW_SOURCE)(
    selfObj,
    cachesObj,
    (req: unknown) => fetchImpl(req),
  );

  // Run 'install' so the SHELL list (including './index.html') is precached.
  let installed: Promise<unknown> = Promise.resolve();
  listeners.get('install')?.({ waitUntil: (p: Promise<unknown>) => { installed = p; } });
  await installed;

  // Fire-and-forget cache writes ride a short microtask chain
  // (caches.open(...).then(c => c.put(...))); a few awaits flush it.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  return {
    setFetch(impl) {
      fetchImpl = impl;
    },
    async navigate(url) {
      let responded: Promise<FakeResponse | undefined> | undefined;
      listeners.get('fetch')?.({
        request: { method: 'GET', mode: 'navigate', url, headers: { has: () => false } },
        respondWith(p: Promise<FakeResponse | undefined>) {
          responded = Promise.resolve(p);
        },
      });
      const out = await responded;
      await flush();
      return out;
    },
    async asset(url, opts = {}) {
      let responded: Promise<FakeResponse | undefined> | undefined;
      listeners.get('fetch')?.({
        request: {
          method: 'GET',
          mode: opts.mode ?? 'cors',
          url,
          headers: { has: (h: string) => h === 'range' && !!opts.range },
        },
        respondWith(p: Promise<FakeResponse | undefined>) {
          responded = Promise.resolve(p);
        },
      });
      const out = responded ? await responded : undefined;
      await flush();
      return out;
    },
    cachedShell() {
      for (const c of cachesObj.caches.values()) {
        const hit = c.store.get('./index.html');
        if (hit) return hit;
      }
      return undefined;
    },
    cached(key) {
      for (const c of cachesObj.caches.values()) {
        const hit = c.store.get(key);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

describe('sw.js — navigation handler must not poison the cached app shell', () => {
  it('a navigation to credits.html passes through WITHOUT overwriting the cached shell', async () => {
    // The poisoning scenario: the viewer links to credits.html (target
    // _blank ⇒ mode 'navigate'). Pre-fix, its response was cached under
    // './index.html' and the next offline load served the credits page as
    // the app. The response must still reach the user (network-first) —
    // only the cache write is withheld.
    const sw = await bootWorker();
    sw.setFetch(() => Promise.resolve(res('credits-page')));
    const out = await sw.navigate('https://viewer.example/credits.html');
    expect(out?.marker).toBe('credits-page');
    expect(sw.cachedShell()?.marker).toBe('precached:./index.html');
  });

  it('an error or redirected response at the root never overwrites the shell', async () => {
    const sw = await bootWorker();
    // 500 at the scope root (e.g. a misconfigured deploy) — not a shell.
    sw.setFetch(() => Promise.resolve(res('server-error', { ok: false, status: 500 })));
    await sw.navigate('https://viewer.example/');
    expect(sw.cachedShell()?.marker).toBe('precached:./index.html');
    // A redirect tail (res.redirected) — could be a captive portal or an
    // auth interstitial, not the app shell.
    sw.setFetch(() => Promise.resolve(res('redirect-tail', { redirected: true })));
    await sw.navigate('https://viewer.example/');
    expect(sw.cachedShell()?.marker).toBe('precached:./index.html');
  });

  it('a clean root navigation DOES refresh the cached shell (both spellings)', async () => {
    const sw = await bootWorker();
    sw.setFetch(() => Promise.resolve(res('fresh-shell')));
    await sw.navigate('https://viewer.example/');
    expect(sw.cachedShell()?.marker).toBe('fresh-shell');
    sw.setFetch(() => Promise.resolve(res('fresher-shell')));
    await sw.navigate('https://viewer.example/index.html');
    expect(sw.cachedShell()?.marker).toBe('fresher-shell');
  });

  it('shell detection follows the registration scope, not a hardcoded "/"', async () => {
    // Deployed under a sub-path: the scope root is /app/, so /app/ is the
    // shell and /app/credits.html is not.
    const sw = await bootWorker('https://host.example/app/');
    sw.setFetch(() => Promise.resolve(res('subpath-shell')));
    await sw.navigate('https://host.example/app/');
    expect(sw.cachedShell()?.marker).toBe('subpath-shell');
    sw.setFetch(() => Promise.resolve(res('subpath-credits')));
    await sw.navigate('https://host.example/app/credits.html');
    expect(sw.cachedShell()?.marker).toBe('subpath-shell');
  });

  it('the offline fallback still serves the cached shell when the network fails', async () => {
    const sw = await bootWorker();
    sw.setFetch(() => Promise.reject(new Error('offline')));
    const out = await sw.navigate('https://viewer.example/');
    expect(out?.marker).toBe('precached:./index.html');
  });
});

describe('sw.js — asset cache stores ONLY content-hashed app bundles, never datasets', () => {
  // What the build actually emits under /assets/ (Vite `<name>-<hash>.<ext>`).
  const BUNDLES = [
    '/assets/Viewer-BdLwXtsu.js',
    '/assets/index-DaDnDjF_.css',
    '/assets/three.core-BR74sD8Y.js',
    '/assets/vendor-three-webgpu-BI7fE5Nu.js',
    '/assets/manrope-latin-400-normal-8tf8FM3T.woff2',
    '/assets/jetbrains-mono-latin-400-normal-6-qcROiO.woff',
  ];
  // Datasets a self-hoster might place anywhere — must NEVER be cached, even
  // when they sit under /assets/ (the folder name is not proof of an app asset).
  const DATASETS = [
    '/assets/user.laz',
    '/assets/scan.copc.laz',
    '/assets/points.las',
    '/assets/tile.bin',
    '/assets/tile.zst',
    '/assets/ept.json',
    '/assets/ept-hierarchy/0-0-0-0.json',
    '/assets/ept-data/0-0-0-0.laz',
    '/data/user.laz',
    '/user.copc.laz',
  ];

  it('caches every content-hashed application bundle under /assets/', async () => {
    const sw = await bootWorker();
    for (const path of BUNDLES) {
      const url = `https://viewer.example${path}`;
      sw.setFetch(() => Promise.resolve(res(`bytes:${path}`)));
      await sw.asset(url);
      expect(sw.cached(url)?.marker).toBe(`bytes:${path}`);
    }
  });

  it('NEVER caches a dataset, regardless of extension or directory (incl. under /assets/)', async () => {
    const sw = await bootWorker();
    for (const path of DATASETS) {
      const url = `https://viewer.example${path}`;
      sw.setFetch(() => Promise.resolve(res(`bytes:${path}`)));
      await sw.asset(url);
      expect(sw.cached(url)).toBeUndefined();
    }
  });

  it('does not cache even a hashed bundle when requested with a Range header', async () => {
    // Partial reads pass straight to the network (top-of-handler range guard).
    const sw = await bootWorker();
    const url = 'https://viewer.example/assets/Viewer-BdLwXtsu.js';
    sw.setFetch(() => Promise.resolve(res('ranged')));
    await sw.asset(url, { range: true });
    expect(sw.cached(url)).toBeUndefined();
  });

  it('honours the registration scope for a sub-path deploy', async () => {
    const sw = await bootWorker('https://host.example/app/');
    const bundle = 'https://host.example/app/assets/Viewer-BdLwXtsu.js';
    const dataset = 'https://host.example/app/assets/user.laz';
    sw.setFetch(() => Promise.resolve(res('sub-bundle')));
    await sw.asset(bundle);
    expect(sw.cached(bundle)?.marker).toBe('sub-bundle');
    sw.setFetch(() => Promise.resolve(res('sub-dataset')));
    await sw.asset(dataset);
    expect(sw.cached(dataset)).toBeUndefined();
  });
});
