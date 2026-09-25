import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * Colour-mode switches on a loaded scan raise no page errors, including a
 * switch issued straight after another. The sliced path itself is covered by
 * tests/slicedRecolour.test.ts.
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

async function cycleModes(page: Page): Promise<void> {
  const chip = (name: string) => page.locator('.olv-chip', { hasText: name }).first();
  await chip('Height').click();
  await chip('RGB').click();
  await chip('Height').click();
  await page.waitForTimeout(1500);
  await chip('RGB').click();
  await page.waitForTimeout(1500);
  await expect(chip('RGB')).toBeVisible();
}

test('colour-mode switches on a small scan raise no page errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await cycleModes(page);
  expect(errors).toEqual([]);
});
