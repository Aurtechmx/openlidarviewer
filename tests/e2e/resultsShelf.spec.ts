/**
 * The Results shelf: a `Results · N` control at the foot of the left rail that
 * lists the session's results and returns to them. Focus routes to the page
 * that owns a result and never reruns an analysis; Export opens the Export
 * mode; a result from another layer says so and the active layer stays put.
 * Deterministic project, synthetic dense-grid PLY.
 */
import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dropDenseGridPly, showWorkspaceMode } from './helpers';

const MULTICHUNK = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));

async function openAndMeasure(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500); // the test API mounts on viewerLoaded
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__?: {
      setMeasureKind: (k: string) => void;
      placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
    } }).__OLV_TEST_API__;
    if (!api) throw new Error('__OLV_TEST_API__ not mounted');
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 1, y: 0, z: 0 });
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
}

const shelf = (page: Page) => page.locator('#olv-left-panels .olv-results-shelf');

test.describe('results shelf', () => {
  test.slow();

  test('B: a measurement appears, and Focus from Data returns to Measure with its state', async ({ page }) => {
    await openAndMeasure(page);
    const toggle = shelf(page).locator('.olv-results-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText(/Results · 1/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await showWorkspaceMode(page, 'data');
    await expect(page.locator('.olv-measure-panel')).toBeHidden();

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const row = shelf(page).locator('.olv-results-row[data-result-type="measurement"]');
    await expect(row).toHaveCount(1);
    await expect(shelf(page).locator('.olv-results-group')).toHaveText(['Measurements']);
    const focus = row.locator('.olv-results-focus');
    await expect(focus).toBeFocused();
    const box = await focus.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Enter');

    await expect(page.locator('.olv-ws-tab[data-mode="work"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.olv-measure-panel')).toBeVisible();
    await expect(page.locator('#olv-ws-mode-work .olv-ws-task-title')).toHaveText('Measure');
    await expect(page.locator('.olv-mp-row')).toHaveCount(1);
    await expect(shelf(page).locator('.olv-results-live')).toHaveText(/^Showing /);

    // Escape closes the list and returns focus to the toggle.
    await focus.focus();
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
  });

  test('E: Export opens the Export mode', async ({ page }) => {
    await openAndMeasure(page);
    await shelf(page).locator('.olv-results-toggle').click();
    await shelf(page).locator('.olv-results-export').first().click();
    await expect(page.locator('.olv-ws-tab[data-mode="output"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.olv-export-panel')).toBeVisible();
    const group = page.locator('.olv-export-product-group[data-product="measurements"]');
    await expect(group).toHaveAttribute('aria-current', 'true');
    await expect(group).toHaveClass(/is-selected/);
    await expect(page.locator('.olv-export-products-head')).toHaveAttribute('aria-expanded', 'true');
    await expect(group.locator('button').first()).toBeFocused();
    await expect(page.locator('.olv-export-product-group.is-selected')).toHaveCount(1);
    await expect(shelf(page).locator('.olv-results-live')).toHaveText(/selected\.$/);
  });

  test('F: a result from another layer says so and Focus keeps the active layer', async ({ page }) => {
    await openAndMeasure(page);
    await showWorkspaceMode(page, 'data');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.olv-add-dataset-row').click();
    await (await chooser).setFiles(MULTICHUNK);
    await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 60_000 });
    const activeBefore = await page.evaluate(() => document.querySelector('.olv-layer.is-active .olv-layer-name')?.textContent ?? null);

    await shelf(page).locator('.olv-results-toggle').click();
    const row = shelf(page).locator('.olv-results-row[data-result-type="measurement"]');
    await expect(row).toHaveClass(/is-other-source/, { timeout: 5_000 });
    await expect(row.locator('.olv-results-meta')).toContainText('From dense-grid.ply');
    await row.locator('.olv-results-focus').click();
    await expect(shelf(page).locator('.olv-results-live')).toHaveText(/The active layer is unchanged\./);
    const activeAfter = await page.evaluate(() => document.querySelector('.olv-layer.is-active .olv-layer-name')?.textContent ?? null);
    expect(activeAfter).toBe(activeBefore);
  });

  test('terrain: Focus from Tools returns to Analyse in two clicks without a rerun', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    await showWorkspaceMode(page, 'analyse');
    const panel = page.locator('.olv-analyse-panel');
    if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
    await page.locator('.olv-analyse-run').click();
    const verdict = page.locator('.olv-fit-verdict-text');
    await expect(verdict).toBeVisible({ timeout: 20_000 });
    const row = shelf(page).locator('.olv-results-row[data-result-type="terrain"]');
    await expect(shelf(page).locator('.olv-results-toggle')).toHaveText(/Results · [1-9]/, { timeout: 10_000 });
    // Mark the rendered result; a rerun would rebuild it.
    await verdict.evaluate((el) => el.setAttribute('data-e2e-mark', '1'));
    await showWorkspaceMode(page, 'work');
    await expect(panel).toBeHidden();

    // Two clicks: open the shelf, Focus the row.
    await shelf(page).locator('.olv-results-toggle').click();
    await row.locator('.olv-results-focus').click();
    await expect(page.locator('.olv-ws-tab[data-mode="analyse"]')).toHaveAttribute('aria-selected', 'true');
    await expect(verdict).toBeVisible();
    await expect(verdict).toHaveAttribute('data-e2e-mark', '1');

    // Export preselects the DEM package in the Export mode's terrain lane.
    // The list stays open after Focus.
    await expect(shelf(page).locator('.olv-results-toggle')).toHaveAttribute('aria-expanded', 'true');
    await row.locator('.olv-results-export').click();
    await expect(page.locator('.olv-ws-tab[data-mode="output"]')).toHaveAttribute('aria-selected', 'true');
    const dem = page.locator('.olv-export-product-group[data-product="terrain-dem"]');
    await expect(dem).toHaveAttribute('aria-current', 'true');
    await expect(dem.locator('button')).toHaveText('DEM package (ZIP)');
    await expect(page.locator('.olv-export-product-group[data-product="contours"]')).toBeVisible();
    await expect(verdict).toHaveAttribute('data-e2e-mark', '1');
  });

  test('closing the scan empties the shelf', async ({ page }) => {
    await openAndMeasure(page);
    await expect(shelf(page).locator('.olv-results-toggle')).toBeVisible();
    await page.locator('.olv-tool-close').click();
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });
    await expect(shelf(page)).toBeHidden();
  });
});
