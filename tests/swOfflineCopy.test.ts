/**
 * swOfflineCopy.test.ts
 *
 * The opt-in offline copy in public/sw.js: install caches only the fixed shell
 * (no manifest fetch), the page's save/remove messages fill or delete the
 * offline cache with progress, an updated worker refills it on activate when
 * one existed, and the build's manifest carries byte sizes.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSwPrecacheManifest } from '../scripts/lib/swPrecacheManifest.mjs';

const SW_SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../public/sw.js'), 'utf8');
const VERSION = /const VERSION = '([^']+)'/.exec(SW_SOURCE)![1];
const SHELL = `${VERSION}@/`;
const OFFLINE = `${SHELL}-offline`;
const ORIGIN = 'https://viewer.example';

const HTML = '<!doctype html><script type="module" src="./assets/index-AAAAAAAA.js"></script>';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const BODIES: Record<string, string> = {
  './assets/index-AAAAAAAA.js': 'export const a = 1;',
  './assets/Viewer-BBBBBBBB.js': 'export const viewer = 2;',
};
const MANIFEST = {
  index: { url: './index.html', sha256: sha(HTML) },
  totalBytes: 30,
  assets: [
    { url: './assets/index-AAAAAAAA.js', bytes: 10, sha256: sha(BODIES['./assets/index-AAAAAAAA.js']) },
    { url: './assets/Viewer-BBBBBBBB.js', bytes: 20, sha256: sha(BODIES['./assets/Viewer-BBBBBBBB.js']) },
    { url: './samples/tiny.ply', bytes: 5 }, // not an app bundle: ignored
  ],
};
const FALLBACK_PAGE = '<!doctype html><title>Not found</title>';

type Served = { body: string; type: string; status?: number };
interface HarnessOptions {
  failUrl?: string;
  manifestOk?: boolean;
  html?: string;
  manifest?: object;
  /** Replace what the host returns for one URL (for example an HTML fallback page with status 200). */
  serve?: Record<string, Served>;
  scope?: string;
  /** Share CacheStorage with another harness, as two deployments on one origin do. */
  stores?: Map<string, Map<string, unknown>>;
}

function harness(initial: Record<string, string[]>, opts: HarnessOptions = {}) {
  const stores = opts.stores ?? new Map<string, Map<string, unknown>>();
  for (const [k, v] of Object.entries(initial)) stores.set(k, new Map(v.map((u) => [u, true])));
  const scope = opts.scope ?? '/';
  const fetched: string[] = [];
  const listeners = new Map<string, (e: unknown) => void>();
  const abs = (u: string) => new URL(u, ORIGIN + (opts.scope ?? '/')).href;
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const s = stores.get(name)!;
    return {
      addAll: async (urls: string[]) => urls.forEach((u) => s.set(abs(u), true)),
      add: async (u: string) => {
        if (opts.failUrl && u === opts.failUrl) throw new Error('404');
        s.set(abs(u), true);
      },
      put: async (u: string | { url: string }, res?: Response) => {
        s.set(abs(typeof u === 'string' ? u : u.url), res ? await res.clone().text() : true);
      },
      match: async (u: string | { url: string }) => {
        const key = abs(typeof u === 'string' ? u : u.url);
        if (!s.has(key)) return undefined;
        const v = s.get(key);
        return typeof v === 'string' && key.endsWith('.json') ? new Response(v) : name + ':' + key;
      },
      keys: async () => [...s.keys()].map((url) => ({ url })),
      delete: async (r: { url: string }) => s.delete(r.url),
    };
  };
  const cachesObj = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (k: string) => stores.delete(k),
    match: async () => undefined,
  };
  const selfObj = {
    addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    location: { origin: ORIGIN, href: ORIGIN + scope + 'sw.js' },
    registration: { scope: ORIGIN + scope },
  };
  let offline = false;
  const fetchFn = async (input: string | { url: string }) => {
    const u = typeof input === 'string' ? input : input.url;
    if (offline) throw new Error('offline');
    fetched.push(u);
    const served = opts.serve?.[u] ?? (BODIES[u] !== undefined ? { body: BODIES[u], type: 'text/javascript' } : undefined);
    if (served) {
      if (opts.failUrl === u) return new Response('missing', { status: 404 });
      return new Response(served.body, { status: served.status ?? 200, headers: { 'content-type': served.type } });
    }
    if (u === './index.html') {
      if (opts.failUrl === u) return { ok: false, status: 404, redirected: false };
      const bytes = new TextEncoder().encode(opts.html ?? HTML);
      return { ok: true, status: 200, redirected: false, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer: async () => bytes.buffer };
    }
    return { ok: opts.manifestOk !== false, status: opts.manifestOk === false ? 404 : 200, json: async () => opts.manifest ?? MANIFEST };
  };
  new Function('self', 'caches', 'fetch', 'URL', SW_SOURCE)(selfObj, cachesObj, fetchFn, URL);
  const fire = async (type: string, extra: object = {}) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => (done = p), ...extra });
    await done;
  };
  const message = async (data: object, origin = ORIGIN) => {
    const replies: Record<string, unknown>[] = [];
    await fire('message', { data, origin, ports: [{ postMessage: (m: Record<string, unknown>) => replies.push(m) }] });
    return replies;
  };
  const offlineIndex = async () => {
    offline = true;
    try {
      let response: Promise<unknown> = Promise.resolve();
      await fire('fetch', {
        request: { method: 'GET', url: ORIGIN + '/', mode: 'navigate', headers: { has: () => false } },
        respondWith: (pending: Promise<unknown>) => { response = pending; },
      });
      return await response;
    } finally {
      offline = false;
    }
  };
  const assetFetch = async (path: string) => {
    let response: Promise<unknown> = Promise.resolve();
    const pending: Promise<unknown>[] = [];
    await fire('fetch', {
      request: { method: 'GET', url: ORIGIN + scope + path.replace(/^\.\//, ''), mode: 'cors', headers: { has: () => false } },
      respondWith: (p: Promise<unknown>) => { response = p; },
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    const r = await response;
    await Promise.all(pending);
    return r;
  };
  return { stores, fetched, fire, message, offlineIndex, assetFetch };
}

describe('service worker opt-in offline copy', () => {
  it('install caches only the shell and never fetches the manifest', async () => {
    const h = harness({});
    await h.fire('install');
    expect(h.fetched).toEqual([]);
    expect(h.stores.has(OFFLINE)).toBe(false);
    expect(h.stores.get(SHELL)!.size).toBeGreaterThan(0);
  });

  it('save fills the offline cache with the listed app bundles and reports progress then done', async () => {
    const h = harness({});
    const replies = await h.message({ type: 'olv-offline-save' });
    expect([...h.stores.get(OFFLINE)!.keys()].sort()).toEqual([
      `${ORIGIN}/assets/Viewer-BBBBBBBB.js`,
      `${ORIGIN}/assets/index-AAAAAAAA.js`,
      `${ORIGIN}/index.html`,
      `${ORIGIN}/sw-precache.json`,
    ]);
    expect(replies.filter((r) => r.type === 'progress')).toHaveLength(2);
    expect(replies.at(-1)).toEqual({ type: 'done', total: 2, failed: 0 });
  });

  it('counts a failed file without aborting the rest', async () => {
    const h = harness({}, { failUrl: './assets/index-AAAAAAAA.js' });
    const replies = await h.message({ type: 'olv-offline-save' });
    expect(replies.at(-1)).toEqual({ type: 'done', total: 2, failed: 1 });
    expect(h.stores.get(OFFLINE)!.has(`${ORIGIN}/assets/Viewer-BBBBBBBB.js`)).toBe(true);
  });

  it('reports an error when the manifest is missing', async () => {
    const h = harness({}, { manifestOk: false });
    const replies = await h.message({ type: 'olv-offline-save' });
    expect(replies.at(-1)).toEqual({ type: 'error' });
  });

  it.each([
    ['an index.html from another build', { html: HTML + '<!-- next deploy -->' }],
    ['an index.html that references an unlisted bundle', { html: '<script src="./assets/index-ZZZZZZZZ.js"></script>', manifest: { ...MANIFEST, index: { url: './index.html', sha256: sha('<script src="./assets/index-ZZZZZZZZ.js"></script>') } } }],
    ['a manifest with no index digest', { manifest: { totalBytes: 30, assets: MANIFEST.assets } }],
  ])('refuses %s and keeps the previous offline copy untouched', async (_label, options) => {
    const saved = [ORIGIN + '/index.html', ORIGIN + '/assets/old-AAAAAAAA.js'];
    const h = harness({ [OFFLINE]: saved }, options);
    const replies = await h.message({ type: 'olv-offline-save' });
    expect(replies.at(-1)).toEqual({ type: 'error', reason: 'build-mismatch' });
    expect([...h.stores.get(OFFLINE)!.keys()].sort()).toEqual([...saved].sort());
    expect(replies.filter((r) => r.type === 'progress')).toEqual([]);
    expect(await h.offlineIndex()).toBe(OFFLINE + ':' + ORIGIN + '/index.html');
  });

  it('remove deletes this scope\'s offline caches and keeps the shell', async () => {
    const h = harness({ [SHELL]: ['a'], [OFFLINE]: ['b'], 'olv-shell-0.6.9-offline': ['c'], 'other-app': ['d'] });
    const replies = await h.message({ type: 'olv-offline-remove' });
    expect(replies).toEqual([{ type: 'removed' }]);
    expect([...h.stores.keys()].sort()).toEqual(['other-app', SHELL].sort());
  });

  it('stores the bytes the manifest describes', async () => {
    const h = harness({});
    await h.message({ type: 'olv-offline-save' });
    expect(h.stores.get(OFFLINE)!.get(`${ORIGIN}/assets/index-AAAAAAAA.js`)).toBe(BODIES['./assets/index-AAAAAAAA.js']);
    expect(h.stores.get(OFFLINE)!.has(`${ORIGIN}/sw-precache.json`)).toBe(true);
  });

  it.each([
    ['an HTML fallback page with status 200', { body: FALLBACK_PAGE, type: 'text/html' }],
    ['a script whose bytes differ from the manifest', { body: 'export const a = 999;', type: 'text/javascript' }],
    ['a redirect-free 200 with the right bytes but a wrong type', { body: BODIES['./assets/index-AAAAAAAA.js'], type: 'text/plain' }],
  ])('does not store %s and commits nothing', async (_label, served) => {
    const saved = [ORIGIN + '/index.html', ORIGIN + '/assets/old-AAAAAAAA.js'];
    const h = harness({ [OFFLINE]: saved }, { serve: { './assets/index-AAAAAAAA.js': served } });
    const replies = await h.message({ type: 'olv-offline-save' });
    expect(replies.at(-1)).toEqual({ type: 'done', total: 2, failed: 1 });
    expect(h.stores.get(OFFLINE)!.has(`${ORIGIN}/assets/index-AAAAAAAA.js`)).toBe(false);
    for (const url of saved) expect(h.stores.get(OFFLINE)!.has(url)).toBe(true);
    expect(h.stores.get(OFFLINE)!.get(`${ORIGIN}/index.html`)).toBe(true); // the earlier index, not the new one
  });

  it('refuses a manifest whose bundles have no digests', async () => {
    const h = harness({}, { manifest: { ...MANIFEST, assets: MANIFEST.assets.map(({ url, bytes }) => ({ url, bytes })) } });
    const replies = await h.message({ type: 'olv-offline-save' });
    expect(replies.at(-1)).toEqual({ type: 'error', reason: 'build-mismatch' });
    expect(h.stores.has(OFFLINE)).toBe(false);
  });

  it('a background refresh never stores an HTML fallback page or bytes the saved manifest does not list', async () => {
    const h = harness({});
    await h.message({ type: 'olv-offline-save' });
    const fallback = harness({}, { stores: h.stores, serve: { [ORIGIN + '/assets/index-AAAAAAAA.js']: { body: FALLBACK_PAGE, type: 'text/html' } } });
    await fallback.assetFetch('./assets/index-AAAAAAAA.js');
    const changed = harness({}, { stores: h.stores, serve: { [ORIGIN + '/assets/index-AAAAAAAA.js']: { body: 'export const a = 999;', type: 'text/javascript' } } });
    await changed.assetFetch('./assets/index-AAAAAAAA.js');
    expect(h.stores.get(SHELL)?.has(`${ORIGIN}/assets/index-AAAAAAAA.js`) ?? false).toBe(false);
    const good = harness({}, { stores: h.stores, serve: { [ORIGIN + '/assets/index-AAAAAAAA.js']: { body: BODIES['./assets/index-AAAAAAAA.js'], type: 'text/javascript' } } });
    await good.assetFetch('./assets/index-AAAAAAAA.js');
    expect(h.stores.get(SHELL)!.get(`${ORIGIN}/assets/index-AAAAAAAA.js`)).toBe(BODIES['./assets/index-AAAAAAAA.js']);
  });

  it('two deployments on one origin keep separate offline copies', async () => {
    const stores = new Map<string, Map<string, unknown>>();
    const a = harness({}, { scope: '/a/', stores });
    const b = harness({}, { scope: '/b/', stores });
    await a.message({ type: 'olv-offline-save' });
    await b.message({ type: 'olv-offline-save' });
    const aCache = `${VERSION}@/a/-offline`;
    const bCache = `${VERSION}@/b/-offline`;
    expect(stores.get(aCache)!.has(`${ORIGIN}/a/index.html`)).toBe(true);
    expect(stores.get(bCache)!.has(`${ORIGIN}/b/index.html`)).toBe(true);
    // Saving /b/ left /a/'s files alone.
    expect([...stores.get(aCache)!.keys()].every((k) => k.startsWith(`${ORIGIN}/a/`))).toBe(true);
    // Removing /a/'s copy leaves /b/'s.
    await a.message({ type: 'olv-offline-remove' });
    expect(stores.has(aCache)).toBe(false);
    expect(stores.get(bCache)!.has(`${ORIGIN}/b/index.html`)).toBe(true);
    // And /b/'s activate does not prune /a/'s shell.
    stores.set(`${VERSION}@/a/`, new Map([[`${ORIGIN}/a/index.html`, true]]));
    await b.fire('activate');
    expect(stores.has(`${VERSION}@/a/`)).toBe(true);
  });

  it('ignores messages without a reply port', async () => {
    const h = harness({});
    await h.fire('message', { data: { type: 'olv-offline-save' }, origin: ORIGIN, ports: [] });
    expect(h.fetched).toEqual([]);
  });

  it('ignores messages from another origin', async () => {
    const h = harness({});
    const replies = await h.message({ type: 'olv-offline-save' }, 'https://evil.example');
    expect(h.fetched).toEqual([]);
    expect(replies).toEqual([]);
  });

  it('activate refills the offline cache for the new build when the user had opted in, then drops the old one', async () => {
    const h = harness({ 'olv-shell-0.6.9': ['x'], 'olv-shell-0.6.9-offline': ['y'], 'other-app': ['z'] });
    await h.fire('activate');
    expect(h.stores.has('olv-shell-0.6.9')).toBe(false);
    expect(h.stores.has('olv-shell-0.6.9-offline')).toBe(false);
    expect(h.stores.get(OFFLINE)!.size).toBe(4); // two bundles, their committed shell and its manifest
    expect(h.stores.has('other-app')).toBe(true);
  });

  it.each([{ manifestOk: false }, { failUrl: './assets/index-AAAAAAAA.js' }, { failUrl: './index.html' }])(
    'keeps both pieces of the previous offline copy after a failed upgrade (%o)', async (options) => {
      const old = 'olv-shell-0.7.0';
      const h = harness({ [old]: [ORIGIN + '/'], [old + '-offline']: [ORIGIN + '/assets/old-AAAAAAAA.js'] }, options);
      await h.fire('activate');
      expect(h.stores.has(old)).toBe(true);
      expect(h.stores.has(old + '-offline')).toBe(true);
      expect(h.stores.get(OFFLINE)?.has(ORIGIN + '/index.html') ?? false).toBe(false);
      expect(await h.offlineIndex()).toBe(old + ':' + ORIGIN + '/');
    },
  );

  it('does not prune the last committed snapshot on a failed same-cache retry', async () => {
    const saved = [ORIGIN + '/index.html', ORIGIN + '/assets/old-AAAAAAAA.js'];
    const h = harness({ [OFFLINE]: saved }, { failUrl: './assets/index-AAAAAAAA.js' });
    await h.message({ type: 'olv-offline-save' });
    for (const url of saved) expect(h.stores.get(OFFLINE)!.has(url)).toBe(true);
    expect(await h.offlineIndex()).toBe(OFFLINE + ':' + ORIGIN + '/index.html');
  });

  it('activate prunes entries a previous build left in the current offline cache', async () => {
    const h = harness({ [OFFLINE]: [`${ORIGIN}/assets/index-OLDOLDOL.js`] });
    await h.fire('activate');
    expect(h.stores.get(OFFLINE)!.has(`${ORIGIN}/assets/index-OLDOLDOL.js`)).toBe(false);
    expect(h.stores.get(OFFLINE)!.size).toBe(4); // two bundles, their committed shell and its manifest
  });

  it('activate does not download anything when the user never opted in', async () => {
    const h = harness({ 'olv-shell-0.6.9': ['x'] });
    await h.fire('activate');
    expect(h.fetched).toEqual([]);
    expect(h.stores.has(OFFLINE)).toBe(false);
  });
});

describe('sw-precache.json manifest', () => {
  it('lists hashed bundles with byte sizes and their total', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olv-swm-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'assets', 'index-AAAAAAAA.js'), 'x'.repeat(10));
      writeFileSync(join(dir, 'assets', 'lazDecode-BBBBBBBB.wasm'), 'x'.repeat(25));
      writeFileSync(join(dir, 'assets', 'readme.txt'), 'ignored');
      writeFileSync(join(dir, 'index.html'), HTML);
      expect(buildSwPrecacheManifest(dir)).toEqual({
        index: { url: './index.html', sha256: sha(HTML) },
        totalBytes: 35,
        assets: [
          { url: './assets/index-AAAAAAAA.js', bytes: 10, sha256: sha('x'.repeat(10)) },
          { url: './assets/lazDecode-BBBBBBBB.wasm', bytes: 25, sha256: sha('x'.repeat(25)) },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
