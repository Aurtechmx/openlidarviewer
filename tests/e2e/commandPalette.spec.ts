import { test, expect, type Page } from '@playwright/test';
import { seedStaleReloadCooldown } from './helpers';

/**
 * v0.3.9 command palette — Cmd-K / Ctrl-K.
 *
 * The pure data layer (fuzzy matcher + ranker) is covered by
 * commandPalette.test.ts (23 unit tests). This spec exercises the
 * DOM + key handler: Cmd-K opens the palette, Esc closes it, typing
 * filters the list, arrow keys move the selection, Enter fires an
 * action.
 */

async function openPalette(page: Page): Promise<void> {
  await page.goto('/');
  // The host's Cmd-K handler listens on `window` and only requires
  // the cmd/ctrl modifier. Playwright maps Meta to Cmd on macOS and
  // Control on Linux/Windows, so we use ControlOrMeta.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
}

test.describe('command palette open / close', () => {
  test('Cmd-K opens the palette and focuses the search input', async ({
    page,
  }) => {
    await openPalette(page);
    const input = page.locator('.olv-palette-input');
    await expect(input).toBeFocused();
  });

  test('Esc closes the palette', async ({ page }) => {
    await openPalette(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-palette')).toBeHidden();
  });

  test('clicking the backdrop closes the palette', async ({ page }) => {
    await openPalette(page);
    // Click the very top-left of the backdrop — far from the card.
    await page.locator('.olv-palette-backdrop').click({
      position: { x: 5, y: 5 },
    });
    await expect(page.locator('.olv-palette')).toBeHidden();
  });

  test('Cmd-K twice toggles the palette', async ({ page }) => {
    await openPalette(page);
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.locator('.olv-palette')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.locator('.olv-palette')).toBeVisible();
  });
});

test.describe('command palette accessibility', () => {
  test('the input is a combobox that owns a listbox of options', async ({ page }) => {
    await openPalette(page);
    const input = page.locator('.olv-palette-input');
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(input).toHaveAttribute('aria-autocomplete', 'list');
    const listId = await input.getAttribute('aria-controls');
    expect(listId).toBeTruthy();
    const list = page.locator(`#${listId}`);
    await expect(list).toHaveAttribute('role', 'listbox');
    const rows = page.locator('.olv-palette-row');
    await expect(rows.first()).toHaveAttribute('role', 'option');
  });

  test('the highlighted row is the active descendant and follows the arrow keys', async ({ page }) => {
    await openPalette(page);
    const input = page.locator('.olv-palette-input');
    const rows = page.locator('.olv-palette-row');
    const firstId = await rows.nth(0).getAttribute('id');
    expect(firstId).toBeTruthy();
    // Opens on the first row whatever the pointer happens to rest over.
    await expect(input).toHaveAttribute('aria-activedescendant', firstId!);
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    const secondId = await rows.nth(1).getAttribute('id');
    await expect(input).toHaveAttribute('aria-activedescendant', secondId!);
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'false');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  });

  test('a stationary pointer over the list does not move the selection on open', async ({ page }) => {
    await page.goto('/');
    // Park the pointer where the list will appear, then open by keyboard.
    await page.mouse.move(640, 420);
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.locator('.olv-palette')).toBeVisible();
    await expect(page.locator('.olv-palette-row').nth(0)).toHaveAttribute('aria-selected', 'true');
    // Moving the pointer hands selection to the row under it.
    await page.mouse.move(641, 421);
    const hovered = page.locator('.olv-palette-row:hover');
    if (await hovered.count()) await expect(hovered.first()).toHaveAttribute('aria-selected', 'true');
  });

  test('closing the palette collapses the combobox', async ({ page }) => {
    await openPalette(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-palette-input')).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('command palette filtering + ranking', () => {
  test('every action is visible on an empty query', async ({ page }) => {
    await openPalette(page);
    // The host registers at least: 4 camera presets + Frame all +
    // 3 themes + 4 tools = 12 actions minimum.
    const rows = page.locator('.olv-palette-row');
    await expect(rows).not.toHaveCount(0);
    expect(await rows.count()).toBeGreaterThanOrEqual(10);
  });

  test('typing "top" surfaces the Top view action at the top', async ({
    page,
  }) => {
    await openPalette(page);
    await page.locator('.olv-palette-input').fill('top');
    const firstRow = page.locator('.olv-palette-row').first();
    await expect(firstRow).toContainText('Top view');
  });

  test('typing "theme" lists every theme action', async ({ page }) => {
    await openPalette(page);
    await page.locator('.olv-palette-input').fill('theme');
    const rows = page.locator('.olv-palette-row');
    expect(await rows.count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.olv-palette-row', { hasText: 'Dark theme' })).toBeVisible();
    await expect(page.locator('.olv-palette-row', { hasText: 'Light theme' })).toBeVisible();
    await expect(page.locator('.olv-palette-row', { hasText: 'High contrast theme' })).toBeVisible();
  });

  test('no-match query shows the empty state', async ({ page }) => {
    await openPalette(page);
    await page.locator('.olv-palette-input').fill('zzqqxx-never-match');
    await expect(page.locator('.olv-palette-empty')).toBeVisible();
  });
});

test.describe('command palette keyboard navigation', () => {
  test('ArrowDown / ArrowUp move the selection without leaving the input', async ({
    page,
  }) => {
    await openPalette(page);
    const input = page.locator('.olv-palette-input');
    // First row starts active.
    const firstActive = await page
      .locator('.olv-palette-row-active')
      .innerText();
    await input.press('ArrowDown');
    const secondActive = await page
      .locator('.olv-palette-row-active')
      .innerText();
    expect(secondActive).not.toBe(firstActive);
    await input.press('ArrowUp');
    const backToFirst = await page
      .locator('.olv-palette-row-active')
      .innerText();
    expect(backToFirst).toBe(firstActive);
    // Focus stays on the input the whole time.
    await expect(input).toBeFocused();
  });

  test('Enter fires the active row and closes the palette', async ({
    page,
  }) => {
    await openPalette(page);
    await page.locator('.olv-palette-input').fill('frame');
    await page.locator('.olv-palette-input').press('Enter');
    // Palette closes after firing.
    await expect(page.locator('.olv-palette')).toBeHidden();
  });

  test('clicking a row fires the action and closes the palette', async ({
    page,
  }) => {
    await openPalette(page);
    await page.locator('.olv-palette-input').fill('Iso');
    await page.locator('.olv-palette-row', { hasText: 'Iso view' }).click();
    await expect(page.locator('.olv-palette')).toBeHidden();
  });
});

test.describe('command palette over another dialog', () => {
  test('Cmd-K and ? do not open the palette or the shortcut sheet over an open dialog', async ({ page }) => {
    await page.goto('/');
    // Load the sheet first, so the check below is a toggle rather than a chunk fetch.
    await page.keyboard.press('Shift+Slash');
    await expect(page.locator('.olv-shortcuts')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-shortcuts')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('Workflow recorder settings');
    await page.locator('.olv-palette-row', { hasText: 'Workflow recorder settings' }).click();
    const settings = page.locator('.olv-wfc-card');
    await expect(settings).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.olv-wfc-close')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.keyboard.press('Shift+Slash');
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(page.locator('.olv-palette')).toBeHidden();
    await expect(page.locator('.olv-shortcuts')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.locator('.olv-palette')).toBeVisible();
  });
});

test.describe('command palette: action registry chunk failure', () => {
  const REGISTRY_CHUNK = '**/actionDefinitions-*.js';
  const TRY_AGAIN = '.olv-lasso-toast-action';

  test('a failed action registry leaves no palette element behind, attempt after attempt', async ({ page }) => {
    await seedStaleReloadCooldown(page);
    await page.route(REGISTRY_CHUNK, (route) => route.abort());
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.locator(TRY_AGAIN)).toHaveText('Try again', { timeout: 10_000 });
    await expect(page.locator('.olv-palette')).toHaveCount(0);
    // Mark this report's button, so the next report can be told apart from it.
    await page.locator(TRY_AGAIN).evaluate((b) => { (b as HTMLElement).dataset.seen = '1'; });
    await page.locator(TRY_AGAIN).click();
    await expect(page.locator(`${TRY_AGAIN}:not([data-seen])`)).toHaveText('Try again', { timeout: 10_000 });
    await expect(page.locator('.olv-palette')).toHaveCount(0);
  });

  // Firefox re-fetches a specifier that failed once; Chromium and WebKit keep
  // the failure in the module map, so only this leg reaches the network again.
  test('firefox: Try again after a failed action registry opens the palette', async ({ page, browserName }) => {
    test.skip(browserName !== 'firefox', 'Chromium/WebKit cannot re-fetch a failed specifier without a full navigation.');
    await seedStaleReloadCooldown(page);
    // Every fetch of the chunk fails until the failure report is on screen, so
    // an earlier request for it (a preload, another chunk) cannot use up the
    // one failure and let the palette open without a report.
    let failing = true;
    let retried = 0;
    await page.route(REGISTRY_CHUNK, (route) => {
      if (failing) return route.abort();
      retried++;
      return route.continue();
    });
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.locator(TRY_AGAIN)).toHaveText('Try again', { timeout: 10_000 });
    failing = false;
    await page.locator(TRY_AGAIN).click();
    await expect(page.locator('.olv-palette')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.olv-palette')).toHaveCount(1);
    expect(retried).toBeGreaterThan(0);
  });
});
