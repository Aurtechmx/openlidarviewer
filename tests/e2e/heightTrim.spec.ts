import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * v0.3.7 final-polish — height percentile-trim slider e2e.
 *
 * The slider appears beneath the Color By chip rail when "Height" is
 * the active colour mode, hides on every other mode, defaults to 5 %,
 * and the percentage label updates as the slider moves. The actual
 * recolour-on-input is unit-tested at the Viewer level; this spec
 * pins the visibility round-trip and the label-tracking contract
 * that the inspector ships.
 */

async function loadSample(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
}

test('the trim slider hides on Intensity and shows on Height', async ({ page }) => {
  await loadSample(page);
  const trimRow = page.locator('.olv-height-trim-row');

  // The tiny PLY ships with RGB; default mode is RGB → trim hidden.
  await expect(trimRow).toHaveClass(/olv-hidden/);

  // Click Height → trim row becomes visible.
  await page.locator('.olv-chip', { hasText: 'Height' }).first().click();
  await expect(trimRow).not.toHaveClass(/olv-hidden/);

  // Click Intensity → trim row hides again.
  await page.locator('.olv-chip', { hasText: 'Intensity' }).first().click();
  await expect(trimRow).toHaveClass(/olv-hidden/);
});

test('the trim slider defaults to 5 % with a matching label', async ({ page }) => {
  await loadSample(page);
  await page.locator('.olv-chip', { hasText: 'Height' }).first().click();

  const slider = page.locator('.olv-height-trim-slider');
  const label = page.locator('.olv-height-trim-label');
  await expect(slider).toHaveValue('5');
  await expect(label).toHaveText('5%');
});

test('the slider label tracks the slider value as it moves', async ({ page }) => {
  await loadSample(page);
  await page.locator('.olv-chip', { hasText: 'Height' }).first().click();

  const slider = page.locator('.olv-height-trim-slider');
  const label = page.locator('.olv-height-trim-label');

  // Set to 15 via the value attribute + dispatch an input event so the
  // listener fires the same way it would on a real drag. We avoid
  // page.mouse for cross-browser slider-thumb portability.
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = '15';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(label).toHaveText('15%');

  // And back down.
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(label).toHaveText('0%');
});
