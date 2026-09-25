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
 *     /assets/* files are content-hashed and immutable, so this is safe.
 *   - full build copy        → only on request ("Make available offline"),
 *     into its own cache; install caches just the fixed shell.
 */

// Bump on every release: `activate` prunes any OLV cache whose name !== VERSION,
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
const VERSION = 'olv-shell-0.7.0-alpha.1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './brand-mark.svg',
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
const OFFLINE_CACHE = VERSION + OFFLINE_SUFFIX;

function isOfflineCache(k) {
  return k.startsWith(CACHE_PREFIX) && k.endsWith(OFFLINE_SUFFIX);
}

/** Manifest entries as {url, bytes}; accepts the older plain-string form. */
function manifestEntries(m) {
  return (m && Array.isArray(m.assets) ? m.assets : [])
    .map((a) => (typeof a === 'string' ? { url: a, bytes: 0 } : a))
    .filter((a) => a && typeof a.url === 'string' && HASHED_APP_ASSET.test(a.url));
}

/**
 * Cache every content-hashed bundle listed in sw-precache.json (entry, lazy
 * chunks, workers, wasm, fonts) into the offline cache, then drop entries a
 * previous build left there. Only runs when the user asked for an offline
 * copy. Each file is added on its own so one failure cannot abort the rest;
 * `onProgress(done, total)` reports after every file.
 */
function precacheBuild(onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  return fetch('./sw-precache.json', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('manifest ' + res.status))))
    .then((m) =>
      caches.open(OFFLINE_CACHE).then((cache) => {
        const entries = manifestEntries(m);
        const total = entries.length;
        let done = 0;
        let failed = 0;
        const addOne = (a) =>
          cache
            .add(a.url)
            .catch(() => {
              failed += 1;
            })
            .then(() => {
              done += 1;
              report(done, total);
            });
        return Promise.all(entries.map(addOne))
          .then(() => pruneCache(cache, entries))
          .then(() => ({ total, failed }));
      }),
    );
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
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {
        /* a missing shell asset must not abort install */
      }),
  );
});

self.addEventListener('activate', (event) => {
  // Drop caches from older versions, then take control of open clients. When
  // the user opted into an offline copy, refill it for this build first.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        const optedIn = keys.some(isOfflineCache);
        return Promise.all(
          // Only OLV's own caches — never a co-hosted app's cache on this origin.
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== VERSION && k !== OFFLINE_CACHE && !isOfflineCache(k))
            .map((k) => caches.delete(k)),
        )
          .then(() => self.clients.claim())
          .then(() => (optedIn ? precacheBuild().catch(() => {}) : undefined))
          .then(() =>
            Promise.all(keys.filter((k) => isOfflineCache(k) && k !== OFFLINE_CACHE).map((k) => caches.delete(k))),
          );
      }),
  );
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
    const work = precacheBuild((done, total) => port.postMessage({ type: 'progress', done, total }))
      .then((r) => port.postMessage({ type: 'done', total: r.total, failed: r.failed }))
      .catch(() => port.postMessage({ type: 'error' }));
    if (event.waitUntil) event.waitUntil(work);
  } else if (data.type === 'olv-offline-remove') {
    const work = caches
      .keys()
      .then((keys) => Promise.all(keys.filter(isOfflineCache).map((k) => caches.delete(k))))
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
 * `manrope-latin-400-normal-8tf8FM3T.woff2`), so this shape is what an immutable
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
            caches.open(VERSION).then((c) => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
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
    caches.match(req, { ignoreVary: true }).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
