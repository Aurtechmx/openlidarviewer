import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * v0.3.7 patch-view phase 2 — photometric witness e2e.
 *
 * After picking a cloud point with the Inspect tool, the floating
 * point-info card carries a collapsible "Photometric witness" section
 * that surfaces the patch thumbnail + colour-provenance rows. This
 * spec verifies the section's existence in the live DOM when a point
 * is actually picked. The patch reconstruction maths is covered by
 * `tests/patchView.test.ts`; this spec is the DOM-visibility contract.
 */

async function loadSampleAndPick(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  // Let the framing tween settle so canvas clicks land on the cloud.
  await page.waitForTimeout(1500);
  await page.locator('.olv-tool', { hasText: 'Inspect' }).click();
  // Click roughly mid-canvas to pick a point. Tiny PLY positions a few
  // points there reliably.
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
}

test('the Photometric witness section appears after a point is picked', async ({ page }) => {
  await loadSampleAndPick(page);
  const witness = page.locator('.olv-witness-details');
  // The witness only renders when the cloud carries RGB. Tiny PLY does,
  // so the section must materialise once a pick lands. Allow a small
  // timeout so the inspector finishes building the card.
  await expect(witness).toBeVisible({ timeout: 10_000 });
  // The summary carries the documented label.
  await expect(witness.locator('.olv-witness-summary')).toHaveText('Photometric witness');
});

test('opening the witness reveals the canvas + provenance rows', async ({ page }) => {
  await loadSampleAndPick(page);
  const witness = page.locator('.olv-witness-details');
  await expect(witness).toBeVisible({ timeout: 10_000 });
  // Open the <details>.
  await witness.locator('summary').click();
  // The patch canvas + the three documented rows (Scanner / Linear /
  // Display) plus the Coverage row should all be on screen.
  await expect(witness.locator('.olv-witness-canvas')).toBeVisible();
  const labels = witness.locator('.olv-witness-row-label');
  await expect(labels.nth(0)).toHaveText('Scanner');
  await expect(labels.nth(1)).toHaveText('Linear');
  await expect(labels.nth(2)).toHaveText('Display');
  await expect(labels.nth(3)).toHaveText('Coverage');
});
