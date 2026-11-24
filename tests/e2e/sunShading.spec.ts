import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * Sun shading under Colour by, Height: off until asked for, the sun's own
 * sliders appear with the strength, and the legend says the colours are shaded
 * only while they are. tiny.ply is a small cloud, so the pass is short; the
 * directions themselves are unit-tested (sunSurfaceNormals.test.ts).
 */

async function openHeight(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.locator('.olv-chip', { hasText: 'Height' }).first().click();
  await expect(page.getByLabel('Sun shading strength (percent)')).toBeVisible({ timeout: 10_000 });
}

async function setSlider(page: Page, label: string, value: string): Promise<void> {
  await page.getByLabel(label).evaluate((el: HTMLInputElement, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

const STRENGTH = 'Sun shading strength (percent)';
const FROM = 'Sun direction (degrees clockwise from north)';

test('sun shading is off until its strength is raised', async ({ page }) => {
  await openHeight(page);
  await expect(page.getByLabel(STRENGTH)).toHaveValue('0');
  await expect(page.getByLabel(STRENGTH)).toHaveAttribute('aria-valuetext', 'Off');
  await expect(page.getByLabel(FROM)).toBeHidden();
  await expect(page.locator('.olv-colorbar-note')).not.toContainText('sun shading');
});

test('raising the strength shows the sun sliders and settles', async ({ page }) => {
  await openHeight(page);
  await setSlider(page, STRENGTH, '70');
  await expect(page.getByLabel(FROM)).toBeVisible();
  await expect(page.getByLabel(FROM)).toHaveAttribute('aria-valuetext', '315 degrees, north-west');
  // Either the directions land and the legend says so, or the scan has no
  // surface and the control says that; never neither.
  await expect.poll(async () => {
    const note = (await page.locator('.olv-colorbar-note').textContent()) ?? '';
    const status = (await page.locator('.olv-sun-status').textContent()) ?? '';
    return note.includes('sun shading on') || status.includes('too few points');
  }, { timeout: 15_000 }).toBe(true);
  await setSlider(page, STRENGTH, '0');
  await expect(page.getByLabel(FROM)).toBeHidden();
  await expect(page.locator('.olv-colorbar-note')).not.toContainText('sun shading');
});

test('the controls leave with the Height colours and keep their values', async ({ page }) => {
  await openHeight(page);
  await setSlider(page, STRENGTH, '40');
  await page.locator('.olv-chip', { hasText: 'RGB' }).first().click();
  await expect(page.getByLabel(STRENGTH)).toBeHidden();
  await page.locator('.olv-chip', { hasText: 'Height' }).first().click();
  await expect(page.getByLabel(STRENGTH)).toHaveValue('40');
});
