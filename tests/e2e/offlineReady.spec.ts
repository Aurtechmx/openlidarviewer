import { expect, test } from '@playwright/test';
import { dropTinyPly, openClassesPage } from './helpers';

/**
 * Offline reload after "Make available offline".
 *
 * Install caches only the fixed shell, so without opting in an offline reload
 * of the hashed chunks is not guaranteed and is not asserted. The page is
 * visited online, the worker is waited on until it controls the page, the
 * Help action is run and its completion toast awaited, then the context goes
 * offline and the page reloads. The shell must render and a local file must
 * open without any network.
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
  const countOffline = () =>
    page.evaluate(async () => {
      const keys = (await caches.keys()).filter((k) => k.startsWith('olv-shell-') && k.endsWith('-offline'));
      let n = 0;
      for (const k of keys) n += (await (await caches.open(k)).keys()).length;
      return n;
    });
  // Install did not download the build.
  expect(await countOffline()).toBe(0);

  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.keyboard.type('Make available offline');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/The app is available offline \([\d.]+ MB\)/)).toBeVisible({ timeout: 60_000 });
  // More than the fixed shell list: the build's hashed bundles were cached.
  expect(await countOffline()).toBeGreaterThan(50);

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 30_000 });

    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
    // tiny.ply decoded and reached the scene: the class legend reveals in its
    // empty state only after a scan has loaded.
    await openClassesPage(page);
    await expect(page.locator('.olv-class-panel')).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.setOffline(false);
  }
});
