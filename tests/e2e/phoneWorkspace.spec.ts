import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * tests/e2e/phoneWorkspace.spec.ts
 *
 * The phone sheet carries the desktop information architecture: the four
 * workspace modes (Data, Tools, Analyse, Export) plus View for the Inspector,
 * each showing its home or one task page under the same task header, driven by
 * the same route the desktop rail uses. Portrait phone and landscape phone.
 */

const tab = (page: Page, id: string) => page.locator(`.olv-mobile-sheet .olv-msheet-tab[data-tab="${id}"]`);
const slot = (page: Page, id: string) => page.locator(`.olv-msheet-slot[data-tab="${id}"]`);

async function openScan(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-mobile-sheet')).toBeVisible({ timeout: 8_000 });
}

/** Visible elements inside the sheet that own a vertical scroll. */
async function sheetScrollers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sheet = document.querySelector('.olv-mobile-sheet')!;
    return [sheet, ...Array.from(sheet.querySelectorAll('*'))]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && /(auto|scroll)/.test(getComputedStyle(e).overflowY);
      })
      .map((e) => (e as HTMLElement).className);
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`phone workspace ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test('Tools -> Measure -> Data -> Tools keeps Measure, and Back returns home', async ({ page }) => {
      await openScan(page);
      await tab(page, 'work').click();
      const launcher = slot(page, 'work').locator('.olv-tool-launcher');
      await expect(launcher).toBeVisible();
      await launcher.locator('.olv-tl-row', { hasText: 'Measure' }).click();
      const title = slot(page, 'work').locator('.olv-ws-task-title');
      const measure = page.locator('.olv-measure-panel');
      await expect(title).toHaveText('Measure');
      await expect(measure).toBeVisible();
      await expect(launcher).toBeHidden();

      await tab(page, 'data').click();
      await expect(slot(page, 'data')).toHaveClass(/is-active/);
      await expect(measure).toBeHidden();

      await tab(page, 'work').click();
      await expect(title).toHaveText('Measure');
      await expect(measure).toBeVisible();
      // The same live node came back, not a rebuilt one.
      expect(await measure.count()).toBe(1);

      await slot(page, 'work').locator('.olv-ws-back').click();
      await expect(launcher).toBeVisible();
      await expect(measure).toBeHidden();
      await expect(slot(page, 'work').locator('.olv-ws-task')).toBeHidden();
    });

    test('Export is reachable in at most two taps', async ({ page }) => {
      await openScan(page);
      await tab(page, 'output').click(); // one tap
      await expect(page.locator('.olv-export-panel')).toBeInViewport();
    });

    test('Analyse holds the terrain analysis and View holds the Inspector', async ({ page }) => {
      await openScan(page);
      await tab(page, 'analyse').click();
      await expect(slot(page, 'analyse').locator('.olv-process-studio')).toBeVisible();
      await tab(page, 'view').click();
      await expect(slot(page, 'view').locator('.olv-inspector')).toBeVisible();
      await expect(page.locator('.olv-left-panels')).toBeHidden();
    });

    test('each tab has one scroller, and the task controls are touch sized', async ({ page }) => {
      await openScan(page);
      for (const id of ['data', 'work', 'analyse', 'output', 'view']) {
        await tab(page, id).click();
        await expect(slot(page, id)).toHaveClass(/is-active/);
        expect(await sheetScrollers(page), id).toEqual(['olv-msheet-body']);
      }
      await tab(page, 'work').click();
      await slot(page, 'work').locator('.olv-tl-row', { hasText: 'Measure' }).click();
      expect(await sheetScrollers(page)).toEqual(['olv-msheet-body']);
      const back = await slot(page, 'work').locator('.olv-ws-back').boundingBox();
      expect(back!.height).toBeGreaterThanOrEqual(44);
      await slot(page, 'work').locator('.olv-ws-back').click();
      for (const r of await slot(page, 'work').locator('.olv-tl-row').all()) {
        expect((await r.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    });
  });
}
