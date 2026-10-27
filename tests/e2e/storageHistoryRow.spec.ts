import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { suppressOnboardingTour, useAdvancedInspector, waitForLoadIdle } from './helpers';

/**
 * The scan report's "Storage history" row, end to end through the real worker.
 *
 * `storage-history-regridded.las` (written by `scripts/gen-storage-history-fixture.ts`) stores
 * its integers on a 0.01 m grid inside a 0.001 m file scale, so the row must leave "test
 * running" and settle on a supported grid. `tiny.las` has too few points to test. The hover
 * text starts with "Preview." in every state.
 */
async function dropLas(page: Page, path: string, name: string): Promise<void> {
  const bytes = readFileSync(fileURLToPath(new URL(path, import.meta.url)));
  const dataTransfer = await page.evaluateHandle(
    ([b, n]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(b as number[])], n as string));
      return dt;
    },
    [[...bytes], name] as const,
  );
  await waitForLoadIdle(page);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

async function openReport(page: Page): Promise<void> {
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.locator('summary', { hasText: 'Scan report' }).click();
}

const storageValue = (page: Page) =>
  page.locator('.olv-report-row', { has: page.locator('.olv-report-label', { hasText: /^Storage history$/ }) })
    .locator('.olv-report-value');

test.describe('Storage history row', () => {
  test('settles on a supported grid for a re-gridded LAS, with a Preview hover', async ({ page }) => {
    await suppressOnboardingTour(page);
    await useAdvancedInspector(page);
    await page.goto('/');
    await dropLas(page, '../fixtures/storage-history-regridded.las', 'storage-history-regridded.las');
    await openReport(page);

    const value = storageValue(page);
    await expect(value).toBeVisible({ timeout: 20_000 });
    // The worker answers in a second or two; the row must leave "test running".
    await expect(value).not.toHaveText('test running', { timeout: 60_000 });
    await expect(value).toHaveText('coordinates supported on a 0.01 m grid');
    const title = await value.getAttribute('title');
    expect(title?.startsWith('Preview.')).toBe(true);
    expect(title).toContain('olv.storage.grid-history@1');
  });

  test('says "not tested (too few points)" for tiny.las', async ({ page }) => {
    await suppressOnboardingTour(page);
    await useAdvancedInspector(page);
    await page.goto('/');
    await dropLas(page, '../fixtures/tiny.las', 'tiny.las');
    await openReport(page);

    const value = storageValue(page);
    await expect(value).toHaveText('not tested (too few points)', { timeout: 20_000 });
    expect((await value.getAttribute('title'))?.startsWith('Preview.')).toBe(true);
  });
});
