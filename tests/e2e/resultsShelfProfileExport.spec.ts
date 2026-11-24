/**
 * The Results shelf exports the profile its row names: with two saved
 * profiles, Export on the second opens that one's dialog and downloads that
 * one, from the keyboard and on a phone-size window. The collection keeps its
 * own control.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { pdfText } from './pdfText';
import { dropDenseGridUtmLas, dropDenseGridPly } from './helpers';

async function placeTwoProfiles(page: Page): Promise<void> {
  await page.locator('.olv-tool', { hasText: 'Measure' }).first().click();
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind(k: string): void; placeMeasurementPoint(p: { x: number; y: number; z: number }): void; finishMeasurement?(): void } }).__OLV_TEST_API__;
    for (const y of [-1, 1]) {
      api.setMeasureKind('profile');
      api.placeMeasurementPoint({ x: -4, y, z: 0 });
      api.placeMeasurementPoint({ x: 4, y, z: 0 });
      api.finishMeasurement?.();
    }
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(2, { timeout: 10_000 });
}

test('Export on the second of two profiles previews and downloads that profile', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/?test=1');
  await dropDenseGridUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await placeTwoProfiles(page);
  await page.mouse.move(1, 1);
  const shelf = page.locator('#olv-left-panels .olv-results-shelf');
  await shelf.locator('.olv-results-toggle').click();
  const rows = shelf.locator('.olv-results-row[data-result-type="measurement"]');
  await expect(rows).toHaveCount(2);
  const second = rows.filter({ hasText: 'Profile 2' });
  const exp = second.locator('.olv-results-export');
  await expect(exp).toHaveAccessibleName('Export Profile 2 as PDF');
  expect((await exp.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await exp.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('.olv-pe [role="dialog"], [role="dialog"].olv-pe').first();
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const what = dialog.locator('.olv-pe-what');
  await expect(what).toHaveText(/^Profile: Profile 2 · Survey: \S+ · Units: metres · Page: A3$/);
  await dialog.getByLabel('Paper').selectOption('tabloid');
  await dialog.getByLabel('Units').selectOption('imperial');
  await expect(what).toHaveText(/Units: feet · Page: Tabloid$/);
  await dialog.getByLabel('Paper').selectOption('a3');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    dialog.getByRole('button', { name: 'Export PDF' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/Profile[-_ ]2.*\.pdf$/i);
  const text = await pdfText(readFileSync((await download.path())!));
  expect(text).toContain('Profile 2');
  expect(text).not.toContain('Profile 1');
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(exp).toBeFocused();

  const all = shelf.getByRole('button', { name: 'Export all measurements' });
  await all.click();
  await expect(page.locator('.olv-export-product-group[data-product="measurements"]')).toHaveAttribute('aria-current', 'true');
});

test('on a phone-size window the second profile exports from its row', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await placeTwoProfiles(page);
  const shelf = page.locator('.olv-results-shelf');
  await page.locator('.olv-mobile-sheet [role="tab"]', { hasText: /Layers|Data/ }).first().click();
  await expect(shelf).toBeVisible();
  await shelf.locator('.olv-results-toggle').click();
  const exp = shelf.locator('.olv-results-row').filter({ hasText: 'Profile 2' }).locator('.olv-results-export');
  await exp.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = (await exp.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await exp.click();
  await expect(page.locator('.olv-pe-what')).toContainText('Profile: Profile 2 ·', { timeout: 20_000 });
});
