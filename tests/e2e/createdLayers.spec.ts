/**
 * The Created layers list under the class rows in Data: a Contours row
 * appears once a terrain run draws contours, it follows the Analyse "Show"
 * checkbox both ways, and closing the scan removes it.
 */
import { test, expect } from '@playwright/test';
import { dropDenseGridPly, openAnalysePage, openAnalysePanel, closeScanFromDock } from './helpers';

test.describe('created layers list', () => {
  test.slow();

  test('contours row tracks the Analyse checkbox and leaves with the scan', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    const section = page.locator('.olv-overlay-switches');
    await expect(section).toHaveClass(/olv-hidden/);

    await openAnalysePanel(page);
    await page.locator('.olv-analyse-run').click();
    await expect(section).not.toHaveClass(/olv-hidden/, { timeout: 30_000 });
    const row = section.locator('.olv-overlay-row', { hasText: 'Contours' });
    await expect(row).toHaveCount(1);
    const listBox = row.locator('input[type="checkbox"]');
    await expect(listBox).toBeChecked();

    // Analyse checkbox off: the list follows.
    await openAnalysePage(page, 'contours');
    const analyseBox = page.getByLabel('Show contours in the 3D scene', { exact: true });
    await analyseBox.uncheck();
    await expect(listBox).not.toBeChecked();
    await expect(row).toHaveClass(/is-hidden/);

    // List checkbox on (dispatched directly: the list sits on the Data tab).
    await listBox.evaluate((el: HTMLInputElement) => { el.click(); });
    await expect(analyseBox).toBeChecked();

    await closeScanFromDock(page);
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });
    await expect(section).toHaveClass(/olv-hidden/);
    await expect(section.locator('.olv-overlay-row')).toHaveCount(0);
  });
});
