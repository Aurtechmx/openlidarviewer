/**
 * Mode home with a Continue row (spec CE-1, CE-MODE-01 and CE-MODE-02).
 *
 * A mode tab opens that mode's home. When the mode remembers a page, the
 * home's first row is `Continue: <page> · <state>` and opens the page again,
 * with focus on its heading. The remembered page is still stored under
 * `olv.workspace.left.page`. Deterministic project, desktop and phone.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, placeTestDistance } from './helpers';

const bar = (page: Page) => page.locator('.olv-loc:not([hidden])');

async function openScan(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await expect(bar(page)).toBeVisible({ timeout: 10_000 });
}

test.describe('mode home and Continue', () => {
  test.slow();

  test('desktop: a tab opens the home; Continue names the page and its state and returns to it', async ({ page }) => {
    await openScan(page, { width: 1440, height: 900 });
    await page.locator('.olv-ws-tab[data-mode="work"]').click();
    await expect(page.locator('#olv-ws-mode-work .olv-mode-continue')).toBeHidden();
    await page.locator('#olv-ws-mode-work .olv-tool-launcher .olv-tl-row', { hasText: 'Measure' }).first().click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Measure');
    await placeTestDistance(page);

    await page.locator('.olv-ws-tab[data-mode="data"]').click();
    await page.locator('.olv-ws-tab[data-mode="work"]').click();
    // The home, not the remembered page.
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools');
    await expect(page.locator('#olv-ws-mode-work .olv-tool-launcher')).toBeVisible();
    await page.mouse.move(1, 1); // the tab's hover tip sits over the row below it
    const cont = page.locator('#olv-ws-mode-work .olv-mode-continue');
    await expect(cont).toHaveText('Continue: Measure · 1 measurement');
    // First on the home.
    const first = await page.locator('#olv-ws-mode-work > :not(.olv-ws-task):not(.olv-ws-off)').first().getAttribute('class');
    expect(first).toContain('olv-mode-continue');
    // The remembered page keeps its stored key and meaning.
    const stored = await page.evaluate(() => localStorage.getItem('olv.workspace.left.page'));
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ work: 'measure' });

    await cont.click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Measure');
    await expect(page.locator('#olv-ws-mode-work .olv-ws-task-title')).toBeFocused();
    await expect(page.locator('.olv-mp-row')).toHaveCount(1);

    // The tab of the mode already shown keeps its page; Back is the way home.
    await page.locator('.olv-ws-tab[data-mode="work"]').click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Measure');
  });

  test('desktop: an Analyse page is offered back with its status', async ({ page }) => {
    await openScan(page, { width: 1440, height: 900 });
    await page.locator('.olv-ws-tab[data-mode="analyse"]').click();
    await page.locator('.olv-ah-row[data-analysis="terrain"] .olv-ah-open').click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Terrain');
    await page.locator('.olv-ws-tab[data-mode="data"]').click();
    await page.locator('.olv-ws-tab[data-mode="analyse"]').click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse');
    await page.mouse.move(1, 1);
    const cont = page.locator('#olv-ws-mode-analyse .olv-mode-continue');
    await expect(cont).toHaveText(/^Continue: Terrain · (Ready|Review|Blocked)$/);
    await cont.click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Terrain');
    await expect(page.locator('#olv-ws-mode-analyse .olv-ws-task-title')).toBeFocused();
  });

  test('desktop: Back keeps the page remembered, and Escape from the page returns home', async ({ page }) => {
    await openScan(page, { width: 1440, height: 900 });
    await page.locator('.olv-ws-tab[data-mode="data"]').click();
    await page.locator('.olv-data-row', { hasText: 'Classes' }).click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Data › Classes');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveAttribute('data-path', 'Data');
    await expect(page.locator('#olv-ws-mode-data .olv-mode-continue')).toHaveText('Continue: Classes');
  });

  test('phone: a sheet tab opens the home with the Continue row', async ({ page }) => {
    await openScan(page, { width: 390, height: 844 });
    await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="data"]').click();
    await page.locator('.olv-msheet-slot[data-tab="data"] .olv-data-row', { hasText: 'Classes' }).click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Data › Classes');
    await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="work"]').click();
    await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="data"]').click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Data');
    await page.mouse.move(1, 1);
    const cont = page.locator('.olv-msheet-slot[data-tab="data"] .olv-mode-continue');
    await expect(cont).toHaveText('Continue: Classes');
    await cont.click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Data › Classes');
  });
});
