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
 */

// Bump on every release: `activate` deletes any cache whose name !== VERSION,
// so changing the name is what prunes the previous release's cached bundles.
// Tied to the app version so a tagged release prunes automatically.
const VERSION = 'olv-shell-0.5.9';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './favicon.ico',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  // Precache the shell; activate immediately so offline works on the next load.
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
  // Drop caches from older versions, then take control of open clients.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
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
 * The ONLY same-origin responses this worker stores: the build's content-hashed
 * /assets/* bundles (immutable) and the precached shell files. Anything else
 * same-origin — including a dataset a user happens to host under this origin (an
 * EPT ept.json / hierarchy / .laz tile) — must go straight to the network and is
 * never cached, per the privacy contract at the top of this file.
 */
function isCacheableAsset(url) {
  const root = scopeRoot();
  if (url.pathname.startsWith(root + 'assets/')) return true;
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
  event.respondWith(
    caches.match(req).then((cached) => {
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
