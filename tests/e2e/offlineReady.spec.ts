import { expect, test } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * Offline reload after ONE online visit.
 *
 * The page is visited once online, the service worker is waited on until it
 * controls the page and its install step has settled, then the context goes
 * offline and the page reloads. The shell must render from the worker's cache
 * and a local file must open without any network: every chunk, worker and
 * wasm module on the local-open path has to have been precached at install,
 * because none of them was requested through the worker on the first visit.
 *
 * Runs against the production preview (see playwright.config.ts); `vite dev`
 * serves unhashed modules and would not exercise the worker's real rules.
 */
test('app shell reloads offline and opens a local file', async ({ page, context, browserName }) => {
  // Playwright's WebKit fails `page.reload()` with an internal error once the
  // context is offline behind a service worker, before the page can answer;
  // that is a harness limit, not an app result, so the leg is skipped.
  test.skip(browserName === 'webkit', 'Playwright WebKit cannot reload offline behind a service worker');
  // main.ts skips registration under automation (`navigator.webdriver`) so the
  // rest of the suite never runs behind a worker. This spec is the one that
  // needs it, so it presents as a normal browser.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
  });
  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 30_000 });

  // Installed, activated and claiming this page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }),
      );
    }
  });
  const cached = await page.evaluate(async () => {
    const keys = (await caches.keys()).filter((k) => k.startsWith('olv-shell-'));
    let n = 0;
    for (const k of keys) n += (await (await caches.open(k)).keys()).length;
    return n;
  });
  // More than the fixed shell list: the build's hashed bundles were precached.
  expect(cached).toBeGreaterThan(50);

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 30_000 });

    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
    // tiny.ply decoded and reached the scene: the class legend reveals in its
    // empty state only after a scan has loaded.
    await expect(page.locator('.olv-class-panel')).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.setOffline(false);
  }
});
