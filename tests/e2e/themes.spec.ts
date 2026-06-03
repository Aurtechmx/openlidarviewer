import { test, expect, type Browser, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * v0.3.9 Theme system — Dark / Light / High-contrast.
 *
 * The pure-data layer is covered by themes.test.ts (21 unit tests).
 * This spec exercises the DOM + persistence wiring: the Inspector
 * chip rail mounts every theme with the correct active state, clicks
 * route through to a body-class swap, and the choice persists across
 * a page reload.
 *
 * Each test that needs a clean theme starts from a freshly-built
 * context so localStorage from a previous test doesn't leak in. The
 * `newCleanContext` helper also seeds the onboarding-tour-completed
 * key so the tour backdrop doesn't intercept the first click; the
 * default `page` fixture already does this through the global
 * `storageState` in playwright.config, but `browser.newContext()`
 * skips that config and needs the seeding inline.
 *
 * The Inspector is hidden on the empty state (the desktop-audit
 * "don't paint placeholder controls before there's a scan" fix), so
 * every test drops the bundled `tiny.ply` fixture first. That makes
 * the inspector — and therefore the theme rail it contains —
 * visible and clickable.
 */

const THEMES = [
  { name: 'Dark', bodyClass: null },
  { name: 'Light', bodyClass: 'olv-theme-light' },
  { name: 'High contrast', bodyClass: 'olv-theme-high-contrast' },
] as const;

const TOUR_KEY = 'olv:tour:v1:completed';

async function bodyClasses(page: Page): Promise<string[]> {
  return await page.evaluate(() => Array.from(document.body.classList));
}

/**
 * Open a fresh browser context with the onboarding tour pre-marked as
 * completed and the page navigated + a tiny.ply fixture dropped so
 * the inspector is visible. Returns the page and a `dispose`
 * function the test should call at the end.
 */
async function newCleanPage(
  browser: Browser,
): Promise<{ page: Page; dispose: () => Promise<void> }> {
  const ctx = await browser.newContext({
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:4173',
          localStorage: [{ name: TOUR_KEY, value: '1' }],
        },
      ],
    },
  });
  const page = await ctx.newPage();
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-theme-rail')).toBeVisible();
  return {
    page,
    dispose: async () => {
      await ctx.close();
    },
  };
}

/**
 * Same idea but for the default `page` fixture — it already inherits
 * the global storageState from playwright.config, so we only need to
 * load the fixture and wait for the rail.
 */
async function loadAndReady(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-theme-rail')).toBeVisible();
}

test.describe('theme chip rail — Inspector header', () => {
  test('the rail mounts a chip for every theme', async ({ page }) => {
    await loadAndReady(page);
    const rail = page.locator('.olv-theme-rail');
    await expect(rail).toBeVisible();
    for (const { name } of THEMES) {
      const chip = rail.locator('.olv-theme-chip', { hasText: name });
      await expect(chip, `missing theme chip "${name}"`).toBeVisible();
    }
  });

  test('Dark is the default active chip on a clean session', async ({
    browser,
  }) => {
    const { page, dispose } = await newCleanPage(browser);
    const active = page.locator('.olv-theme-chip-active');
    await expect(active).toHaveText('Dark');
    await dispose();
  });
});

test.describe('theme switching — body class + active state', () => {
  test('clicking Light adds the olv-theme-light body class', async ({
    browser,
  }) => {
    const { page, dispose } = await newCleanPage(browser);
    await page
      .locator('.olv-theme-rail .olv-theme-chip', { hasText: 'Light' })
      .click();
    const classes = await bodyClasses(page);
    expect(classes).toContain('olv-theme-light');
    expect(classes).not.toContain('olv-theme-high-contrast');
    await expect(page.locator('.olv-theme-chip-active')).toHaveText('Light');
    await dispose();
  });

  test('clicking High contrast swaps the body class cleanly', async ({
    browser,
  }) => {
    const { page, dispose } = await newCleanPage(browser);
    await page
      .locator('.olv-theme-rail .olv-theme-chip', { hasText: 'Light' })
      .click();
    await page
      .locator('.olv-theme-rail .olv-theme-chip', { hasText: 'High contrast' })
      .click();
    const classes = await bodyClasses(page);
    expect(classes).toContain('olv-theme-high-contrast');
    expect(classes).not.toContain('olv-theme-light');
    await dispose();
  });

  test('clicking Dark removes every theme body class', async ({ browser }) => {
    const { page, dispose } = await newCleanPage(browser);
    await page
      .locator('.olv-theme-rail .olv-theme-chip', { hasText: 'Light' })
      .click();
    await page
      .locator('.olv-theme-rail .olv-theme-chip', { hasText: 'Dark' })
      .click();
    const classes = await bodyClasses(page);
    expect(classes).not.toContain('olv-theme-light');
    expect(classes).not.toContain('olv-theme-high-contrast');
    await dispose();
  });
});

test.describe('persistence — theme survives a page reload', () => {
  test('High-contrast persists across reload via localStorage', async ({
    browser,
  }) => {
    const { page, dispose } = await newCleanPage(browser);
    await page
      .locator('.olv-theme-rail .olv-theme-chip', { hasText: 'High contrast' })
      .click();
    await expect(page.locator('.olv-theme-chip-active')).toHaveText(
      'High contrast',
    );

    await page.reload();
    // After reload the empty state returns — drop the fixture again so
    // the inspector renders the (now-persisted) active theme chip.
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    await expect(page.locator('.olv-theme-chip-active')).toHaveText(
      'High contrast',
    );
    const classes = await bodyClasses(page);
    expect(classes).toContain('olv-theme-high-contrast');
    await dispose();
  });

  test('Light persists across reload', async ({ browser }) => {
    const { page, dispose } = await newCleanPage(browser);
    await page
      .locator('.olv-theme-rail .olv-theme-chip', { hasText: 'Light' })
      .click();

    await page.reload();
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    await expect(page.locator('.olv-theme-chip-active')).toHaveText('Light');
    const classes = await bodyClasses(page);
    expect(classes).toContain('olv-theme-light');
    await dispose();
  });
});
