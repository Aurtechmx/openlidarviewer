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
const OFFLINE = `${VERSION}-offline`;
const ORIGIN = 'https://viewer.example';

const HTML = '<!doctype html><script type="module" src="./assets/index-AAAAAAAA.js"></script>';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const MANIFEST = {
  index: { url: './index.html', sha256: sha(HTML) },
  totalBytes: 30,
  assets: [
    { url: './assets/index-AAAAAAAA.js', bytes: 10 },
    { url: './assets/Viewer-BBBBBBBB.js', bytes: 20 },
    { url: './samples/tiny.ply', bytes: 5 }, // not an app bundle: ignored
  ],
};

function harness(initial: Record<string, string[]>, opts: { failUrl?: string; manifestOk?: boolean; html?: string; manifest?: object } = {}) {
  const stores = new Map<string, Map<string, true>>();
  for (const [k, v] of Object.entries(initial)) stores.set(k, new Map(v.map((u) => [u, true as const])));
  const fetched: string[] = [];
  const listeners = new Map<string, (e: unknown) => void>();
  const abs = (u: string) => new URL(u, ORIGIN + '/').href;
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const s = stores.get(name)!;
    return {
      addAll: async (urls: string[]) => urls.forEach((u) => s.set(abs(u), true)),
      add: async (u: string) => {
        if (opts.failUrl && u === opts.failUrl) throw new Error('404');
        s.set(abs(u), true);
      },
      put: async (u: string) => { s.set(abs(u), true); },
      match: async (u: string) => s.has(abs(u)) ? name + ':' + abs(u) : undefined,
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
    location: { origin: ORIGIN, href: ORIGIN + '/sw.js' },
    registration: { scope: ORIGIN + '/' },
  };
  let offline = false;
  const fetchFn = async (u: string) => {
    if (offline) throw new Error('offline');
    fetched.push(u);
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
  return { stores, fetched, fire, message, offlineIndex };
}

describe('service worker opt-in offline copy', () => {
  it('install caches only the shell and never fetches the manifest', async () => {
    const h = harness({});
    await h.fire('install');
    expect(h.fetched).toEqual([]);
    expect(h.stores.has(OFFLINE)).toBe(false);
    expect(h.stores.get(VERSION)!.size).toBeGreaterThan(0);
  });

  it('save fills the offline cache with the listed app bundles and reports progress then done', async () => {
    const h = harness({});
    const replies = await h.message({ type: 'olv-offline-save' });
    expect([...h.stores.get(OFFLINE)!.keys()].sort()).toEqual([
      `${ORIGIN}/assets/Viewer-BBBBBBBB.js`,
      `${ORIGIN}/assets/index-AAAAAAAA.js`,
      `${ORIGIN}/index.html`,
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

  it('remove deletes every OLV offline cache and keeps the shell', async () => {
    const h = harness({ [VERSION]: ['a'], [OFFLINE]: ['b'], 'olv-shell-0.6.9-offline': ['c'], 'other-app': ['d'] });
    const replies = await h.message({ type: 'olv-offline-remove' });
    expect(replies).toEqual([{ type: 'removed' }]);
    expect([...h.stores.keys()].sort()).toEqual(['other-app', VERSION].sort());
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
    expect(h.stores.get(OFFLINE)!.size).toBe(3); // two bundles and their committed shell
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
    expect(h.stores.get(OFFLINE)!.size).toBe(3); // two bundles and their committed shell
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
          { url: './assets/index-AAAAAAAA.js', bytes: 10 },
          { url: './assets/lazDecode-BBBBBBBB.wasm', bytes: 25 },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
