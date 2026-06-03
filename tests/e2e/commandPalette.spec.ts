import { test, expect, type Page } from '@playwright/test';

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
