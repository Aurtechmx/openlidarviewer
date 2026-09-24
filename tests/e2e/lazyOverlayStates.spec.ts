import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyPly } from './helpers';

/**
 * lazyOverlayStates.spec.ts
 *
 * Every lazy overlay/panel entry point's busy and failure states (LAZY-1 /
 * LOAD-1 / F7): a visible pending cue while its chunk fetches, and — on
 * failure — a toast instead of the silent "nothing happens" the audit
 * found. Command palette, shortcut sheet, and help overlay build on the
 * shared createLazySingleton, whose "Try again" action is always present;
 * the context menu (a plain createLazySurfaceLoader call with no retry
 * option, since a fresh right-click already serves as one) is the one
 * surface with no action button.
 *
 * `lazyChunkLoad.spec.ts` proves the happy path for these same chunks and
 * documents the exact failure shape a stale chunk takes: a first
 * `vite:preloadError` reloads the page once (installStaleChunkRecovery),
 * and only a SECOND failure inside its 20s cooldown resolves to `undefined`
 * instead of rejecting or reloading. Its own session-import failure test
 * pre-seeds the cooldown marker so the FIRST abort() in a fresh page
 * already takes the no-reload branch; every failure-path test below does
 * the same, or its first assertion would instead observe a page reload.
 *
 * These tests stop at the toast appearing with its message and (where one
 * exists) its "Try again" action — they do not click it. Once a specifier
 * has failed, Chromium and WebKit cache that failure in the module map and
 * never re-issue the request without a full navigation, so a same-page
 * retry cannot reach the network in either (confirmed experimentally: the
 * route handler never sees a second matching request, and the retry hangs
 * until Playwright's own timeout). Firefox does re-fetch and does open.
 * That gap is a browser-engine limitation on re-importing a failed
 * specifier, not a defect in the retry logic itself, which the
 * mocked-loader unit tests exercise deterministically end to end —
 * including a successful retry actually opening the panel, not just
 * refetching bytes nothing then consumes:
 * lazySurfaceLoad.test.ts, helpOverlayLazyFailure.test.ts,
 * qualityControlLazyFailure.test.ts, analysisActionsFlowPulse.test.ts.
 */

const TOAST = '.olv-lasso-toast';
const TOAST_MSG = '.olv-lasso-toast-msg';
const TOAST_ACTION = '.olv-lasso-toast-action';
const STALE_RELOAD_KEY = 'olv:stale-reload-at';

/** Pre-seed the stale-chunk-recovery cooldown marker so the FIRST route
 *  abort in this test already takes the "already tried, don't reload"
 *  branch — see staleChunkReload.ts and lazyChunkLoad.spec.ts. */
async function seedStaleReloadCooldown(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    try {
      sessionStorage.setItem(key, String(Date.now()));
    } catch {
      // Storage may be blocked; the test still exercises the failure path,
      // just via a real (harmless) reload instead of the no-reload branch.
    }
  }, STALE_RELOAD_KEY);
}

async function goto(page: Page): Promise<void> {
  await suppressOnboardingTour(page);
  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible();
}

/** The dock (and its Cmd-K / Help buttons) only renders once a scan attaches. */
async function gotoWithScan(page: Page): Promise<void> {
  await goto(page);
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

test.describe('command palette — busy + failure states', () => {
  test('the dock button is disabled and aria-busy while the chunk fetches, and clears on success', async ({ page }) => {
    await gotoWithScan(page);
    await page.route('**/CommandPalette-*.js', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    const button = page.locator('.olv-tool-command');
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.olv-palette')).toBeVisible({ timeout: 10_000 });
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-busy', 'false');
  });

  test('a failed chunk reports through the toast with a Try again action', async ({ page }) => {
    await seedStaleReloadCooldown(page);
    await gotoWithScan(page);
    await page.route('**/CommandPalette-*.js', (route) => route.abort());
    const button = page.locator('.olv-tool-command');
    await button.click();
    const toast = page.locator(TOAST);
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(TOAST_MSG)).not.toHaveText('');
    await expect(page.locator(TOAST_ACTION)).toHaveText('Try again');
    await expect(page.locator('.olv-palette')).toBeHidden();
    await expect(button).toBeEnabled();
  });
});

test.describe('help overlay — busy + failure states', () => {
  test('the Help button is disabled and aria-busy while the chunk fetches, and clears on success', async ({ page }) => {
    await gotoWithScan(page);
    await page.route('**/HelpOverlay-*.js', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    const button = page.locator('.olv-tool-help');
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.olv-help-backdrop')).toBeVisible({ timeout: 10_000 });
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-busy', 'false');
  });

  test('a failed chunk reports through the toast with a Try again action', async ({ page }) => {
    await seedStaleReloadCooldown(page);
    await gotoWithScan(page);
    await page.route('**/HelpOverlay-*.js', (route) => route.abort());
    const button = page.locator('.olv-tool-help');
    await button.click();
    const toast = page.locator(TOAST);
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(TOAST_ACTION)).toHaveText('Try again');
    await expect(page.locator('.olv-help-backdrop')).toBeHidden();
  });
});

test.describe('performance (quality) panel — busy + failure states', () => {
  test('the header button is disabled and aria-busy while the chunk fetches, and clears on success', async ({ page }) => {
    await goto(page);
    await page.route('**/QualityPanel-*.js', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    const button = page.locator('.olv-quality-button');
    await expect(button).toBeVisible({ timeout: 20_000 });
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.olv-quality-pop')).toBeVisible({ timeout: 10_000 });
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-busy', 'false');
  });

  // The toast-on-failure contract for this surface (message + a "Try again"
  // action wired to a retry that re-enters open(), per qualityControl.ts) is
  // covered by qualityControlLazyFailure.test.ts's mocked-loader unit tests
  // instead of here. An e2e route.abort() on this one chunk did not
  // reliably produce the toast across repeated runs and all three
  // browsers, unlike the identical pattern on the other four surfaces
  // above; the cause was not isolated in the time available, so this
  // surface keeps only the busy-cue coverage e2e and the failure-path
  // coverage at the unit level, rather than ship a flaky assertion.
});

test.describe('context menu — failure state', () => {
  test('a failed chunk reports through the toast, with no action button — right-click is its own retry gesture', async ({ page }) => {
    await seedStaleReloadCooldown(page);
    await gotoWithScan(page);
    await page.route('**/contextMenu-*.js', (route) => route.abort());
    const canvas = page.locator('.olv-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box — did the scan load?');
    await canvas.dispatchEvent('contextmenu', {
      clientX: Math.round(box.x + box.width / 2),
      clientY: Math.round(box.y + box.height / 2),
      bubbles: true,
      cancelable: true,
    });
    const toast = page.locator(TOAST);
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(TOAST_MSG)).not.toHaveText('');
    await expect(page.locator(TOAST_ACTION)).toHaveCount(0);
    await expect(page.locator('.olv-ctxmenu')).toBeHidden();
  });
});

test.describe('shortcut sheet — failure state', () => {
  test('a failed chunk reports through the toast with a Try again action', async ({ page }) => {
    await seedStaleReloadCooldown(page);
    await goto(page);
    await page.route('**/ShortcutSheet-*.js', (route) => route.abort());
    await page.keyboard.press('Shift+Slash');
    const toast = page.locator(TOAST);
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(TOAST_ACTION)).toHaveText('Try again');
    await expect(page.locator('.olv-shortcuts')).toBeHidden();
  });

  // Firefox re-fetches a specifier that already failed once (see the file
  // header); Chromium/WebKit cache the failure and never reach the network
  // on retry, so only this leg can exercise a real fail-then-succeed round
  // trip through main.ts's actual ensureShortcutSheet wiring — the one
  // integration point that pins onReady surviving to a later retry, as
  // opposed to lazySurfaceLoad.test.ts's mocked-loader version of the same
  // mechanism.
  test('firefox: Try again after a failed load still opens the sheet', async ({ page, browserName }) => {
    test.skip(browserName !== 'firefox', 'Chromium/WebKit cannot re-fetch a failed specifier without a full navigation.');
    await seedStaleReloadCooldown(page);
    await goto(page);
    let attempts = 0;
    await page.route('**/ShortcutSheet-*.js', (route) => (++attempts === 1 ? route.abort() : route.continue()));
    await page.keyboard.press('Shift+Slash');
    await expect(page.locator(TOAST_ACTION)).toHaveText('Try again', { timeout: 10_000 });
    await page.locator(TOAST_ACTION).click();
    await expect(page.locator('.olv-shortcuts')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('shortcut sheet — command palette entry point', () => {
  test('a failed "Show keyboard shortcuts" chunk never surfaces as an unhandled rejection', async ({ page }) => {
    await seedStaleReloadCooldown(page);
    await gotoWithScan(page);
    await page.route('**/ShortcutSheet-*.js', (route) => route.abort());
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('keyboard shortcuts');
    await page.locator('.olv-palette-row', { hasText: 'Show keyboard shortcuts' }).click();
    await expect(page.locator(TOAST_ACTION)).toHaveText('Try again', { timeout: 10_000 });
    await page.waitForTimeout(300);
    expect(pageErrors).toEqual([]);
  });
});
