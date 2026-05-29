import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * Measurement toolkit coverage — the toolbar, kind picker, and units toggle
 * (DOM-driven, deterministic), plus a full placement round-trip for the
 * distance tool. The placement test also guards the v0.1.0 straight-line
 * distance measurement against regression.
 */

/** Load the drone-survey sample and enter measurement mode. */
async function loadSampleAndMeasure(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  // Let the framing tween settle so canvas clicks land on the cloud.
  await page.waitForTimeout(1500);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
}

test('the measurement toolbar shows the full kind picker', async ({ page }) => {
  await loadSampleAndMeasure(page);
  // Seven kinds: distance, polyline, area, height, angle, slope, profile.
  await expect(page.locator('.olv-mkind')).toHaveCount(7);
  await expect(page.locator('.olv-mkind-active')).toHaveText('Distance');
});

test('the kind picker includes the new Profile kind', async ({ page }) => {
  await loadSampleAndMeasure(page);
  await expect(page.locator('.olv-mkind', { hasText: 'Profile' })).toBeVisible();
  await page.locator('.olv-mkind', { hasText: 'Profile' }).click();
  await expect(page.locator('.olv-mkind-active')).toHaveText('Profile');
});

test('selecting a kind highlights it', async ({ page }) => {
  await loadSampleAndMeasure(page);
  await page.locator('.olv-mkind', { hasText: 'Area' }).click();
  await expect(page.locator('.olv-mkind-active')).toHaveText('Area');
});

test('the units toggle flips between metric and imperial', async ({ page }) => {
  await loadSampleAndMeasure(page);
  const toggle = page.locator('.olv-units-toggle');
  await expect(toggle).toHaveText('Metric');
  await toggle.click();
  await expect(toggle).toHaveText('Imperial');
  await toggle.click();
  await expect(toggle).toHaveText('Metric');
});

test('placing a distance measurement lists it, and Clear all removes it', async ({
  page,
}) => {
  await loadSampleAndMeasure(page);
  const canvas = page.locator('.olv-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');

  // Two clicks near the centre of the framed cloud place a distance measurement.
  await canvas.click({ position: { x: box.width * 0.44, y: box.height * 0.5 } });
  await canvas.click({ position: { x: box.width * 0.56, y: box.height * 0.52 } });

  // The committed measurement appears as a row in the Measurements panel.
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });

  // Clear all empties the list.
  await page.locator('.olv-measure-clear').click();
  await expect(page.locator('.olv-mp-row')).toHaveCount(0);
});

test('exporting produces a session download', async ({ page }) => {
  await loadSampleAndMeasure(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.olv-mp-action', { hasText: 'Export' }).click(),
  ]);
  // The export uses the current scan's name with an `.olvsession` suffix —
  // the canonical v3 session-file extension.
  expect(download.suggestedFilename()).toMatch(/\.olvsession$/);
});
