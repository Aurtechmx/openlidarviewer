/**
 * The Tools tab answers its own question: the launcher card lists the tools
 * with their keys and says what the session holds, before any tool has run.
 * Clicking Measure runs the registry action, the Measurements panel mounts,
 * and the card folds to its strip so the working panel keeps the column.
 * Runs on the deterministic project against the committed multi-chunk LAZ.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { showWorkspaceMode } from './helpers';

const FIXTURE = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));

test.describe('tools launcher', () => {
  test('lists the tools, the counts, and folds to its strip once Measure is up', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await page.locator('.olv-file-input').first().setInputFiles(FIXTURE);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 60_000 });
    await showWorkspaceMode(page, 'work');

    const card = page.locator('.olv-tool-launcher');
    await expect(card).toBeVisible();
    const rows = card.locator('.olv-tl-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Measure');
    await expect(rows.nth(0).locator('kbd')).toHaveText('M');
    await expect(rows.nth(3)).toContainText('Clip box');
    await expect(card.locator('.olv-tl-counts')).toContainText('0 measurements · 0 annotations');

    await rows.nth(0).click();
    await expect(page.locator('.olv-measure-panel')).toBeVisible();
    await expect(card).toHaveClass(/is-strip/);
    await expect(card.locator('.olv-tl-chip')).toHaveCount(4);
  });
});
