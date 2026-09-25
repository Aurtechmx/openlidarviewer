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
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSwPrecacheManifest } from '../scripts/lib/swPrecacheManifest.mjs';

const SW_SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../public/sw.js'), 'utf8');
const VERSION = /const VERSION = '([^']+)'/.exec(SW_SOURCE)![1];
const OFFLINE = `${VERSION}-offline`;
const ORIGIN = 'https://viewer.example';

const MANIFEST = {
  totalBytes: 30,
  assets: [
    { url: './assets/index-AAAAAAAA.js', bytes: 10 },
    { url: './assets/Viewer-BBBBBBBB.js', bytes: 20 },
    { url: './samples/tiny.ply', bytes: 5 }, // not an app bundle: ignored
  ],
};

function harness(initial: Record<string, string[]>, opts: { failUrl?: string; manifestOk?: boolean } = {}) {
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
      put: async () => {},
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
  const fetchFn = async (u: string) => {
    fetched.push(u);
    return { ok: opts.manifestOk !== false, status: opts.manifestOk === false ? 404 : 200, json: async () => MANIFEST };
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
  return { stores, fetched, fire, message };
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
    expect(h.stores.get(OFFLINE)!.size).toBe(2);
    expect(h.stores.has('other-app')).toBe(true);
  });

  it('activate prunes entries a previous build left in the current offline cache', async () => {
    const h = harness({ [OFFLINE]: [`${ORIGIN}/assets/index-OLDOLDOL.js`] });
    await h.fire('activate');
    expect(h.stores.get(OFFLINE)!.has(`${ORIGIN}/assets/index-OLDOLDOL.js`)).toBe(false);
    expect(h.stores.get(OFFLINE)!.size).toBe(2);
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
      expect(buildSwPrecacheManifest(dir)).toEqual({
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
