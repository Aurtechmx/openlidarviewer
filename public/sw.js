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

const VERSION = 'olv-shell-v1';
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
  // rather than filling the cache with sample point clouds.
  if (url.pathname.startsWith('/samples/')) return;

  // App navigations: network-first with an offline shell fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

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
