/**
 * The Data home: the layer list plus a `Classes` row and a `Source and
 * metadata` row. The class legend is a page under Data; Layer Health lives in
 * the right-rail Inspector. Running a Field Simulation Lab from the palette
 * opens a modal and leaves the rail mode alone.
 * Deterministic project, committed classified `tiny.las` and the dense grid.
 */
import { test, expect } from '@playwright/test';
import { dropDenseGridPly, dropTinyLas, firePaletteAction, showWorkspaceMode } from './helpers';

test.describe('Data home', () => {
  test.slow();

  test('open LAS -> Data -> Layer Health in the Inspector -> Classes page -> toggle a class -> Back', async ({ page }) => {
    await page.goto('/');
    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await showWorkspaceMode(page, 'data');

    const home = page.locator('#olv-ws-mode-data');
    const classesRow = home.locator('.olv-data-row', { hasText: 'Classes' });
    await expect(home.locator('.olv-layers-section')).toBeVisible();
    await expect(classesRow).toContainText(/\d+ detected/, { timeout: 20_000 });
    await expect(home.locator('.olv-data-row', { hasText: 'Source and metadata' })).toBeVisible();
    await expect(home.locator('.olv-class-panel')).toBeHidden();
    await expect(home.locator('.olv-reclass-panel')).toBeHidden();

    // Layer Health is per-scan: it sits in the Inspector, never in the left rail.
    await expect(page.locator('#olv-left-panels .olv-layerhealth-card')).toHaveCount(0);
    await expect(page.locator('.olv-inspector .olv-layerhealth-card')).toHaveCount(1, { timeout: 20_000 });

    await classesRow.click();
    const title = home.locator('.olv-ws-task-title');
    await expect(title).toHaveText('Classes');
    await expect(title).toBeFocused();
    const legend = home.locator('.olv-class-panel');
    await expect(legend).toBeVisible();
    // Edit classes rides with the legend onto the page.
    await expect(legend.locator('.olv-reclass-panel')).toBeVisible({ timeout: 20_000 });
    await expect(home.locator('.olv-layers-section')).toBeHidden();

    const check = legend.locator('.olv-cl-row .olv-cl-check').first();
    await check.uncheck();
    await expect(legend.locator('.olv-cl-banner')).toBeVisible();

    await home.locator('.olv-ws-back').click();
    await expect(legend).toBeHidden();
    await expect(classesRow).toBeVisible();
    // Navigation is presentation only: the hidden class stays hidden.
    await classesRow.click();
    await expect(check).not.toBeChecked();
  });

  test('Flow Pulse from the palette while in Tools keeps the Tools mode', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await showWorkspaceMode(page, 'work');
    await firePaletteAction(page, 'Flow Pulse', 'Flow Pulse (Field Simulation Lab)');
    await expect(page.locator('.olv-modal-title')).toHaveText('Field Simulation Lab: Flow Pulse');
    await expect(page.locator('.olv-ws-tab[data-mode="work"]')).toHaveAttribute('aria-selected', 'true');
  });
});
