import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * v0.4.3 Theme system — Dark / Light / High-contrast.
 *
 * The pure-data layer is covered by themes.test.ts (21 unit tests) and the
 * control itself by themeToggle.test.ts (7 unit tests). This spec exercises
 * the DOM + persistence WIRING after the v0.4.3 relocation: the theme
 * control is no longer an Inspector chip rail — it's a single shape-morphing
 * button in the top-right header (`.olv-theme-toggle`). It is present on the
 * empty state (it lives in the top bar, not the scan-gated Inspector), one
 * click cycles Dark → Light → High-contrast → Dark with the matching
 * body-class swap, and the choice persists across a page reload.
 *
 * This is a relocation, not a weakening: every assertion the old chip-rail
 * spec made (mounts, active state, body-class swap on each theme, reload
 * persistence) is preserved — only the selector and the click model (cycle
 * vs. direct pick) changed.
 *
 * Each test that needs a clean theme starts from a freshly-built context so
 * localStorage from a previous test doesn't leak in. The helper seeds the
 * onboarding-tour-completed key so the tour backdrop doesn't intercept the
 * first click.
 */

const TOUR_KEY = 'olv:tour:v1:completed';

/** The lit icon's `data-theme` — the source of truth for the current theme. */
async function activeIconTheme(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const lit = document.querySelector('.olv-theme-icon-active');
    return lit ? lit.getAttribute('data-theme') : null;
  });
}

async function bodyClasses(page: Page): Promise<string[]> {
  return await page.evaluate(() => Array.from(document.body.classList));
}

/**
 * Open a fresh browser context with the onboarding tour pre-marked as
 * completed and the page navigated, then wait for the header theme toggle.
 * The toggle lives in the top bar, so — unlike the old chip rail — it's
 * visible on the empty state with no fixture required.
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
  await expect(page.locator('.olv-theme-toggle')).toBeVisible();
  return {
    page,
    dispose: async () => {
      await ctx.close();
    },
  };
}

async function loadAndReady(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.olv-theme-toggle')).toBeVisible();
}

test.describe('header theme toggle — top-right button', () => {
  test('the toggle mounts an icon for every theme', async ({ page }) => {
    await loadAndReady(page);
    const toggle = page.locator('.olv-theme-toggle');
    await expect(toggle).toBeVisible();
    for (const theme of ['dark', 'light', 'high-contrast']) {
      await expect(
        toggle.locator(`.olv-theme-icon[data-theme="${theme}"]`),
        `missing theme icon "${theme}"`,
      ).toHaveCount(1);
    }
  });

  test('Dark is the default lit icon on a clean session', async ({
    browser,
  }) => {
    const { page, dispose } = await newCleanPage(browser);
    expect(await activeIconTheme(page)).toBe('dark');
    await expect(page.locator('.olv-theme-toggle')).toHaveAttribute(
      'aria-label',
      /Dark/,
    );
    await dispose();
  });
});

test.describe('theme cycling — body class + lit icon', () => {
  test('one click cycles Dark → Light and adds olv-theme-light', async ({
    browser,
  }) => {
    const { page, dispose } = await newCleanPage(browser);
    await page.locator('.olv-theme-toggle').click();
    const classes = await bodyClasses(page);
    expect(classes).toContain('olv-theme-light');
    expect(classes).not.toContain('olv-theme-high-contrast');
    expect(await activeIconTheme(page)).toBe('light');
    await dispose();
  });

  test('the second click swaps to High contrast cleanly', async ({
    browser,
  }) => {
    const { page, dispose } = await newCleanPage(browser);
    const toggle = page.locator('.olv-theme-toggle');
    await toggle.click(); // dark → light
    await toggle.click(); // light → high-contrast
    const classes = await bodyClasses(page);
    expect(classes).toContain('olv-theme-high-contrast');
    expect(classes).not.toContain('olv-theme-light');
    expect(await activeIconTheme(page)).toBe('high-contrast');
    await dispose();
  });

  test('the third click returns to Dark and clears every theme class', async ({
    browser,
  }) => {
    const { page, dispose } = await newCleanPage(browser);
    const toggle = page.locator('.olv-theme-toggle');
    await toggle.click(); // dark → light
    await toggle.click(); // light → high-contrast
    await toggle.click(); // high-contrast → dark
    const classes = await bodyClasses(page);
    expect(classes).not.toContain('olv-theme-light');
    expect(classes).not.toContain('olv-theme-high-contrast');
    expect(await activeIconTheme(page)).toBe('dark');
    await dispose();
  });
});

test.describe('persistence — theme survives a page reload', () => {
  test('High-contrast persists across reload via localStorage', async ({
    browser,
  }) => {
    const { page, dispose } = await newCleanPage(browser);
    const toggle = page.locator('.olv-theme-toggle');
    await toggle.click(); // dark → light
    await toggle.click(); // light → high-contrast
    expect(await activeIconTheme(page)).toBe('high-contrast');

    await page.reload();
    await expect(page.locator('.olv-theme-toggle')).toBeVisible();

    expect(await activeIconTheme(page)).toBe('high-contrast');
    const classes = await bodyClasses(page);
    expect(classes).toContain('olv-theme-high-contrast');
    await dispose();
  });

  test('Light persists across reload', async ({ browser }) => {
    const { page, dispose } = await newCleanPage(browser);
    await page.locator('.olv-theme-toggle').click(); // dark → light

    await page.reload();
    await expect(page.locator('.olv-theme-toggle')).toBeVisible();

    expect(await activeIconTheme(page)).toBe('light');
    const classes = await bodyClasses(page);
    expect(classes).toContain('olv-theme-light');
    await dispose();
  });
});
