/**
 * swUrl.ts
 *
 * Derive the service-worker script URL from the page URL.
 *
 * The app builds with Vite `base: './'` precisely so a checkout deploys
 * anywhere — the site root, or a sub-path like GitHub Pages'
 * `https://user.github.io/repo/`. Registering the worker as `'/sw.js'`
 * broke that contract: under a sub-path deploy the request went to the
 * ORIGIN root (`/sw.js`), 404'd, and the registration silently failed —
 * no offline support, no PWA install, only on deployments that weren't
 * the developer's own.
 *
 * Resolving `'sw.js'` against the page URL puts the script beside
 * `index.html`, which is where the build emits it (`public/sw.js` is
 * copied verbatim to the dist root). The default registration scope is
 * the script's directory, so the worker controls exactly the deployed
 * app — root deploys behave as before, sub-path deploys get a correctly
 * scoped worker.
 *
 * Pure and unit-tested (`tests/swUrl.test.ts`); the sole caller is the
 * registration block in `main.ts`.
 */

/**
 * The service-worker script URL for the app deployed at `pageHref`.
 *
 * `pageHref` is expected to be `window.location.href` — a directory URL
 * (`…/repo/`), an explicit document (`…/repo/index.html`), with or without
 * query/hash (URL resolution drops both). The one shape this cannot rescue
 * is a directory served WITHOUT its trailing slash (`…/repo`); every static
 * host of note redirects that to `…/repo/` before the app boots.
 */
export function serviceWorkerUrl(pageHref: string): string {
  return new URL('sw.js', pageHref).toString();
}
