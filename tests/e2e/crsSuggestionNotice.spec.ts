import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { suppressOnboardingTour } from './helpers';

/**
 * crsSuggestionNotice.spec.ts
 *
 * A CRS remembered for a file with this name, in a record that cannot be
 * verified as this file (here a legacy record with no identity), is not
 * applied. Besides the toast, the Inspector's Coordinate system section shows a
 * notice with Apply and Dismiss while the suggestion is pending. Applying it
 * records this file's identity, including the content fingerprint the open
 * took from the file's head and tail.
 */

const FIXTURE = 'evlr-crs-utm15.las';

async function seedLegacyRecord(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      localStorage.setItem('olv:crs-overrides', JSON.stringify({
        version: 1,
        entries: [{ key, override: { epsg: 32615, kind: 'projected', updatedAt: 1 } }],
      }));
    } catch {
      // Storage blocked: the spec's expectations then fail visibly.
    }
  }, FIXTURE);
}

async function dropFixture(page: Page): Promise<void> {
  const bytes = readFileSync(fileURLToPath(new URL(`../fixtures/${FIXTURE}`, import.meta.url)));
  const dataTransfer = await page.evaluateHandle(
    ([b, n]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(b as number[])], n as string));
      return dt;
    },
    [[...bytes], FIXTURE] as const,
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

async function openWithSuggestion(page: Page) {
  await suppressOnboardingTour(page);
  await seedLegacyRecord(page);
  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible();
  await dropFixture(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.locator('summary', { hasText: 'Coordinate system' }).first().click();
  await expect(page.locator('.olv-crs-epsg').first()).toHaveText('EPSG:6344', { timeout: 15_000 });
  const notice = page.locator('.olv-crs-suggestion');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('aria-live', 'polite');
  await expect(notice).toContainText('A CRS (EPSG:32615) was remembered for a file with this name.');
  return notice;
}

test('the Inspector notice applies a remembered CRS and records this file', async ({ page }) => {
  const notice = await openWithSuggestion(page);
  await notice.getByRole('button', { name: 'Apply' }).click();
  await expect(notice).toBeHidden();
  await expect(page.locator('.olv-crs-epsg').first()).toHaveText('EPSG:32615');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('olv:crs-overrides') ?? '{}'));
  const record = stored.entries.find((e: { key: string }) => e.key === 'evlr-crs-utm15.las').override;
  expect(record.identityVersion).toBe(2);
  expect(record.identity.digest).toMatch(/^olvsrc1-file:[0-9a-f]{64}$/);
});

test('the Inspector notice dismisses without applying', async ({ page }) => {
  const notice = await openWithSuggestion(page);
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toBeHidden();
  await expect(page.locator('.olv-crs-epsg').first()).toHaveText('EPSG:6344');
});
