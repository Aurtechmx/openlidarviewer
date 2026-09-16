/**
 * The Help overlay: opens from the tool dock once a scan is loaded, lists
 * topics from the catalogue, derives its action rows and keys from the
 * registry and the binding table, and answers a search. Runs on the
 * deterministic project against the committed multi-chunk LAZ fixture.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));

test.describe('help overlay', () => {
  // A cold decode of the fixture can take most of a minute when the whole suite
  // runs in parallel, and the default 30 s budget then expires before the click.
  test.slow();
  test('opens from the dock with searchable topics and canonical shortcuts', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await page.locator('.olv-file-input').first().setInputFiles(FIXTURE);
    // The decode is pooled off-thread and takes longer on the CI runner than the default assertion wait.
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 60_000 });
    await page.getByRole('button', { name: /^Help$/ }).first().click();
    const backdrop = page.locator('.olv-help-backdrop');
    await expect(backdrop).toBeVisible();
    await expect(page.locator('[data-help-topic="scientific-states"]')).toBeVisible();
    // The Measure row and its key come from the registry and the binding table.
    const measure = page.locator('[data-action-id="tool.measure"]');
    await expect(measure).toContainText('Measure');
    await expect(measure.locator('kbd')).toHaveText('M');
    await page.locator('.olv-help-search').fill('preview');
    await expect(page.locator('[data-help-topic="scientific-states"]')).toBeVisible();
    await expect(page.locator('[data-help-topic="navigation"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(backdrop).toBeHidden();
  });
});
