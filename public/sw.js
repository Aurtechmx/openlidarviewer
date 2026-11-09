/*
 * sw.js — OpenLiDARViewer offline service worker.
 *
 * Local-first and privacy-preserving by construction: this worker caches ONLY
 * the app shell and the app's own content-hashed static assets, all same-origin.
 * It never touches cross-origin requests, so opening a remote COPC or catalog
 * dataset still goes straight to the network and nothing the user loads is
 * stored by the worker. Non-GET requests and Range requests (partial reads for
 * streaming COPC) pass through untouched.
 *
 * Served verbatim from public/ (not bundled or obfuscated), so it stays a plain,
 * auditable file at the deploy root with scope "/".
 *
 * Strategy:
 *   - navigations            → network-first, falling back to the cached shell
 *     when offline (keeps a fresh index online; avoids the stale-hash white
 *     screen a precached HTML entry would cause).
 *   - same-origin GET assets → cache-first with a background refresh; the
 *     /assets/* files are content-hashed and immutable, so this is safe. A
 *     refreshed file is stored only when its type and, once an offline copy
 *     exists, its SHA-256 match the build it belongs to.
 *   - full build copy        → only on request ("Make available offline"),
 *     into its own cache; install caches just the fixed shell. Every file is
 *     checked against the SHA-256 in sw-precache.json before it is stored.
 *
 * Several deployments can share one origin (/a/ and /b/). Every cache name
 * carries this worker's scope, and a worker reads, refreshes and deletes only
 * its own scope's caches, so one deployment cannot replace or remove another's
 * offline copy.
 */

// Bump on every release: `activate` prunes this scope's OLV caches of other versions,
// so changing the name is what drops the previous release's cached bundles.
// Tied to the app version so a tagged release prunes automatically. The
// `olv-shell-` prefix is load-bearing: CacheStorage is ORIGIN-wide, not scoped
// to this service worker, so activate must only delete OLV's own caches — never
// a co-hosted app's cache on the same origin.
const CACHE_PREFIX = 'olv-shell-';
// Kept as a plain string literal (not an interpolation of CACHE_PREFIX) so the
// release verifier can machine-check the version by grep. Must stay prefixed
// with CACHE_PREFIX's value; `lint:release-sync` enforces the version part on
// release.
const VERSION = 'olv-shell-0.7.1-alpha.1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './brand-mark.svg',
  './brand-mark-light.svg',
  './favicon.ico',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
];

// The opt-in full copy of the build lives in its own cache so "Remove offline
// copy" can drop it without touching the shell. Its existence is also the
// persisted opt-in: a worker cannot read the page's localStorage, so an
// updated worker re-precaches on activate when any OLV offline cache exists.
const OFFLINE_SUFFIX = '-offline';
// Cache names end with '@' and the scope path: 'olv-shell-0.7.1@/a/' and
// 'olv-shell-0.7.1@/a/-offline'. Names without '@' come from workers before
// this scheme; any scope may read them as a fallback and retire them.
const SCOPE_TAG = '@' + scopeRoot();
const SHELL_CACHE = VERSION + SCOPE_TAG;
const OFFLINE_CACHE = SHELL_CACHE + OFFLINE_SUFFIX;
// The manifest of the committed offline copy, stored beside it. Its digests
// check background refreshes of the same files.
const SAVED_MANIFEST = './sw-precache.json';

/** Whether cache `k` belongs to this worker's scope (or predates scoped names). */
function isOwnCache(k) {
  if (!k.startsWith(CACHE_PREFIX)) return false;
  const base = k.endsWith(OFFLINE_SUFFIX) ? k.slice(0, -OFFLINE_SUFFIX.length) : k;
  return base.endsWith(SCOPE_TAG) || !base.includes('@');
}

function isOfflineCache(k) {
  return isOwnCache(k) && k.endsWith(OFFLINE_SUFFIX);
}

/** Manifest entries as {url, bytes, sha256}; accepts the older plain-string form. */
function manifestEntries(m) {
  return (m && Array.isArray(m.assets) ? m.assets : [])
    .map((a) => (typeof a === 'string' ? { url: a, bytes: 0 } : a))
    .filter((a) => a && typeof a.url === 'string' && HASHED_APP_ASSET.test(a.url));
}

/** The MIME types a browser accepts for each bundle type; anything else (an HTML fallback page) is refused. */
function typeFits(url, contentType) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  const path = new URL(url, self.location.href).pathname.toLowerCase();
  if (/\.m?js$/.test(path)) return /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)$/.test(type);
  if (path.endsWith('.css')) return type === 'text/css';
  if (path.endsWith('.wasm')) return type === 'application/wasm' || type === 'application/octet-stream';
  if (/\.woff2?$/.test(path)) return /^(?:font\/|application\/(?:font-|x-font-|octet-stream))/.test(type);
  return false;
}

/** A plain, same-origin 200 response for the file itself, not a redirect or error page. */
function plainOk(res) {
  return !!res && res.status === 200 && !res.redirected && (res.type === undefined || res.type === 'basic' || res.type === 'default');
}

/**
 * Cache every content-hashed bundle listed in sw-precache.json (entry, lazy
 * chunks, workers, wasm, fonts) into the offline cache, then drop entries a
 * previous build left there. Only runs when the user asked for an offline
 * copy. Each file is added on its own so one failure cannot abort the rest;
 * `onProgress(done, total)` reports after every file.
 */
function deleteObsoleteCaches(keys) {
  return Promise.all(keys.filter((k) => isOwnCache(k) && k !== SHELL_CACHE && k !== OFFLINE_CACHE)
    .map((k) => caches.delete(k)));
}

// Serialize explicit saves and removals so a late save cannot undo a remove.
let offlineChanges = Promise.resolve();
function changeOffline(work) {
  const next = offlineChanges.then(work);
  offlineChanges = next.catch(() => {});
  return next;
}

/** A save refused because the page and the manifest come from different builds. */
class BuildMismatch extends Error {}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch index.html once and check it belongs to the build the manifest
 * describes: its SHA-256 must equal `m.index.sha256`, and every assets/ file it
 * references must be listed. The deploy can change between the manifest
 * request and this one; a mismatch must not be saved. Resolves to the verified
 * bytes and headers, which are the ones stored.
 */
async function verifiedIndex(m, entries) {
  const expected = m && m.index && typeof m.index.sha256 === 'string' ? m.index.sha256.toLowerCase() : null;
  if (!expected) throw new BuildMismatch('manifest has no index digest');
  const res = await fetch('./index.html', { cache: 'no-store' });
  if (!res.ok || res.redirected) throw new Error('index ' + res.status);
  const body = await res.arrayBuffer();
  if (hex(await crypto.subtle.digest('SHA-256', body)) !== expected) throw new BuildMismatch('index digest');
  const listed = new Set(entries.map((a) => new URL(a.url, self.location.href).href));
  const html = new TextDecoder().decode(body);
  for (const ref of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*assets\/[^"']+)["']/gi)) {
    const url = new URL(ref[1], self.location.href);
    if (url.origin === self.location.origin && !listed.has(url.href)) throw new BuildMismatch('unlisted ' + url.pathname);
  }
  return { body, headers: res.headers };
}

/**
 * Fetch one listed bundle and check its bytes against the manifest. Resolves
 * to a Response holding exactly the verified bytes; rejects on a redirect, a
 * non-200 status, a wrong content type or a digest mismatch, so a host's HTML
 * fallback page is never stored in place of a script.
 */
async function verifiedAsset(a) {
  const want = typeof a.sha256 === 'string' ? a.sha256.toLowerCase() : null;
  if (!want) throw new BuildMismatch('no digest for ' + a.url);
  const res = await fetch(a.url, { cache: 'no-store' });
  if (!plainOk(res) || !typeFits(a.url, res.headers.get('content-type'))) throw new Error('asset ' + res.status);
  const body = await res.arrayBuffer();
  if (hex(await crypto.subtle.digest('SHA-256', body)) !== want) throw new Error('asset digest');
  return new Response(body, { status: 200, headers: res.headers });
}

// CacheStorage has no rename. The saved index is the commit record: publish
// it only after all its bundles exist, then retire the preceding snapshot.
// The index is verified against the manifest before any file is written, so
// a refused save leaves the previous copy exactly as it was.
function precacheBuild(onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  return fetch('./sw-precache.json', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('manifest ' + res.status))))
    .then(async (m) => {
      const entries = manifestEntries(m);
      if (!entries.length) throw new Error('Empty offline manifest');
      if (entries.some((a) => typeof a.sha256 !== 'string')) throw new BuildMismatch('manifest has no asset digests');
      const index = await verifiedIndex(m, entries);
      return caches.open(OFFLINE_CACHE).then((cache) => {
        const total = entries.length;
        let done = 0;
        let failed = 0;
        const addOne = (a) =>
          verifiedAsset(a)
            .then((res) => cache.put(a.url, res))
            .catch(() => {
              failed += 1;
            })
            .then(() => {
              done += 1;
              report(done, total);
            });
        return Promise.all(entries.map(addOne)).then(async () => {
          if (!failed) {
            await cache.put(SAVED_MANIFEST, new Response(JSON.stringify(m), { headers: { 'content-type': 'application/json' } }));
            await cache.put('./index.html', new Response(index.body, { status: 200, headers: index.headers }));
            await pruneCache(cache, [...entries, { url: './index.html' }, { url: SAVED_MANIFEST }]);
            savedDigests = null;
            await deleteObsoleteCaches(await caches.keys());
          }
          return { total, failed };
        });
      });
    });
}

/** Delete every entry of `cache` that the manifest `entries` no longer lists. */
function pruneCache(cache, entries) {
  const keep = new Set(entries.map((a) => new URL(a.url, self.location.href).href));
  return cache.keys().then((reqs) => Promise.all(reqs.filter((r) => !keep.has(r.url)).map((r) => cache.delete(r))));
}

self.addEventListener('install', (event) => {
  // Cache only the fixed shell; activate immediately so offline works next load.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {
        /* a missing shell asset must not abort install */
      }),
  );
});

self.addEventListener('activate', (event) => {
  // A failed automatic download must leave the last saved viewer usable.
  event.waitUntil(caches.keys().then(async (keys) => {
    if (keys.some(isOfflineCache)) {
      await changeOffline(() => precacheBuild()).catch(() => {});
    } else {
      await deleteObsoleteCaches(keys);
    }
    await self.clients.claim();
  }));
});

/**
 * Page requests, answered on the MessageChannel port the page passes:
 *   {type:'olv-offline-save'}   → {type:'progress', done, total}…, then
 *                                 {type:'done', total, failed} or {type:'error'}
 *   {type:'olv-offline-remove'} → {type:'removed'}
 */
self.addEventListener('message', (event) => {
  // Only pages of this origin may drive the offline copy.
  if (event.origin !== self.location.origin) return;
  const data = event.data;
  const port = event.ports?.[0];
  if (!data || !port) return;
  if (data.type === 'olv-offline-save') {
    const work = changeOffline(() => precacheBuild((done, total) => port.postMessage({ type: 'progress', done, total })))
      .then((r) => port.postMessage({ type: 'done', total: r.total, failed: r.failed }))
      .catch((err) => port.postMessage(err instanceof BuildMismatch ? { type: 'error', reason: 'build-mismatch' } : { type: 'error' }));
    if (event.waitUntil) event.waitUntil(work);
  } else if (data.type === 'olv-offline-remove') {
    const work = changeOffline(async () => {
      await deleteObsoleteCaches(await caches.keys());
      await caches.delete(OFFLINE_CACHE);
      savedDigests = null;
    })
      .then(() => port.postMessage({ type: 'removed' }))
      .catch(() => port.postMessage({ type: 'error' }));
    if (event.waitUntil) event.waitUntil(work);
  }
});

/**
 * Whether a navigation request targets the app shell itself — the scope root
 * ('/') or its explicit '/index.html'. Resolved against the worker's
 * registration scope so a deploy under a sub-path still recognises its own
 * shell. Only these navigations may refresh the cached './index.html': the
 * old handler cached EVERY same-origin navigation under that key, so visiting
 * credits.html (or landing on an error/redirected page) replaced the cached
 * shell and the next offline load rendered the wrong document (navigation
 * cache-poisoning finding, Critical).
 */
function scopeRoot() {
  const scope = new URL(self.registration && self.registration.scope ? self.registration.scope : './', self.location.href);
  return scope.pathname.endsWith('/') ? scope.pathname : scope.pathname + '/';
}

function isShellNavigation(url) {
  const root = scopeRoot();
  return url.pathname === root || url.pathname === root + 'index.html';
}

/**
 * A build-emitted, content-hashed application bundle: `<name>-<hash>.<ext>` under
 * `assets/`, where `<ext>` is a known application asset type. Vite fingerprints
 * every bundle it emits (`Viewer-BdLwXtsu.js`, `index-DaDnDjF_.css`,
 * `OlvFont-Regular-Latin-8tf8FM3T.woff2`), so this shape is what an immutable
 * app asset looks like — and, crucially, what a user's DATASET never looks like.
 */
const HASHED_APP_ASSET = /(^|\/)assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|wasm|woff2?)$/i;

/**
 * The ONLY same-origin responses this worker stores: the build's content-hashed
 * /assets/* bundles (immutable) and the precached shell files. Anything else
 * same-origin — including a dataset a user happens to host under this origin (an
 * EPT ept.json / hierarchy / .laz / .copc.laz / .bin / .zst tile) — must go
 * straight to the network and is never cached, per the privacy contract at the
 * top of this file.
 *
 * The directory name alone is NOT proof: `assets/` is a natural place to drop a
 * self-hosted point cloud, so the predicate requires the Vite content-hash AND a
 * known application extension. Without both, a dataset placed under `assets/`
 * would otherwise be cached — enforcing the contract, not just asserting it.
 */
function isCacheableAsset(url) {
  const root = scopeRoot();
  if (url.pathname.startsWith(root + 'assets/')) return HASHED_APP_ASSET.test(url.pathname);
  return SHELL.some((s) => url.pathname === root + s.replace(/^\.\//, ''));
}

async function offlineShell() {
  const keys = await caches.keys();
  // The current saved index (if committed) references a complete bundle set.
  if (keys.includes(OFFLINE_CACHE)) {
    const current = await (await caches.open(OFFLINE_CACHE)).match('./index.html');
    if (current) return current;
  }
  for (const saved of keys.filter((key) => isOfflineCache(key) && key !== OFFLINE_CACHE)) {
    const previous = await (await caches.open(saved)).match('./index.html');
    if (previous) return previous;
    // Earlier workers stored all the bundles in the offline cache but their
    // original shell in the companion cache under './'. Network navigations
    // could overwrite the older './index.html' with the new, incompatible HTML.
    const companion = saved.slice(0, -OFFLINE_SUFFIX.length);
    if (keys.includes(companion)) {
      const legacy = await (await caches.open(companion)).match('./');
      if (legacy) return legacy;
    }
  }
  const shell = await caches.open(SHELL_CACHE);
  return (await shell.match('./index.html')) || shell.match('./');
}

/**
 * Look `req` up in this scope's caches only: the current offline copy first,
 * then earlier offline copies (a failed upgrade keeps serving the old build),
 * then the shell. caches.match() would search every cache on the origin,
 * including another deployment's.
 */
async function matchOwn(req) {
  const keys = (await caches.keys()).filter(isOwnCache);
  const rank = (k) => (k === OFFLINE_CACHE ? 0 : k.endsWith(OFFLINE_SUFFIX) ? 1 : k === SHELL_CACHE ? 2 : 3);
  for (const k of keys.sort((a, b) => rank(a) - rank(b))) {
    const hit = await (await caches.open(k)).match(req, { ignoreVary: true });
    if (hit) return hit;
  }
  return undefined;
}

// url -> sha256 of the committed offline copy; null until read, reset on save/remove.
let savedDigests = null;
function digestsForRefresh() {
  if (!savedDigests) {
    savedDigests = (async () => {
      const map = new Map();
      if (!(await caches.keys()).includes(OFFLINE_CACHE)) return map;
      const res = await (await caches.open(OFFLINE_CACHE)).match(SAVED_MANIFEST);
      if (!res) return map;
      for (const a of manifestEntries(await res.json())) {
        if (typeof a.sha256 === 'string') map.set(new URL(a.url, self.location.href).href, a.sha256.toLowerCase());
      }
      return map;
    })().catch(() => new Map());
  }
  return savedDigests;
}

/** Store a background refresh only when it is the file the build describes. */
async function storeRefresh(req, res) {
  if (!plainOk(res) || !typeFits(req.url, res.headers.get('content-type'))) return;
  const body = await res.arrayBuffer();
  const want = (await digestsForRefresh()).get(new URL(req.url).href);
  if (want && hex(await crypto.subtle.digest('SHA-256', body)) !== want) return;
  await (await caches.open(SHELL_CACHE)).put(req, new Response(body, { status: 200, headers: res.headers }));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache writes/uploads
  if (req.headers.has('range')) return; // partial reads go straight to network

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // Cross-origin (remote datasets, catalogs, tiles) is never intercepted or
  // cached — the user's data stays between them and its source.
  if (url.origin !== self.location.origin) return;

  // Bundled demo datasets are large and optional — let them hit the network
  // rather than filling the cache with sample point clouds. Resolved against
  // the registration scope, not the origin root, so a sub-path deploy
  // (…/repo/samples/…) is excluded exactly like a root deploy.
  if (url.pathname.startsWith(scopeRoot() + 'samples/')) return;

  // App navigations: network-first with an offline shell fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Refresh the cached shell ONLY from a clean shell response: the
          // scope root (or its index.html), 2xx, and not the tail of a
          // redirect. Anything else — credits.html, a 404/500 page, a
          // redirect target — must never overwrite './index.html', or the
          // offline fallback would serve a non-app document as the app.
          if (res.ok && !res.redirected && isShellNavigation(url)) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(offlineShell),
    );
    return;
  }

  // Non-asset same-origin GETs — e.g. a dataset a user happens to host under
  // this origin — go straight to the network and are never stored.
  if (!isCacheableAsset(url)) return;

  // Same-origin static assets: serve from cache, refresh in the background.
  // ignoreVary: the bundles are content-hashed and immutable, and a server's
  // `Vary: Origin` would otherwise miss the precached copy for a module script
  // request (which carries Origin) and fail the load offline.
  event.respondWith(
    matchOwn(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const stored = storeRefresh(req, res.clone()).catch(() => {});
            if (event.waitUntil) event.waitUntil(stored);
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
