import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * A glTF that declares NORMAL opens with a normal channel: the Normal colour
 * mode is offered and the point inspector shows the picked point's normal.
 * The fixture is `tests/fixtures/grey-ramp-normals.glb` (see FIXTURES.md).
 */

const FIXTURE = fileURLToPath(new URL('../fixtures/grey-ramp-normals.glb', import.meta.url));

async function openFixture(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await page.locator('.olv-file-input').first().setInputFiles(FIXTURE);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
}

test('a glTF with authored normals offers the Normal colour mode', async ({ page }) => {
  await openFixture(page);
  const chip = page.locator('.olv-chips .olv-chip', { hasText: /^Normal$/ }).first();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await chip.click();
  await expect(chip).toHaveClass(/olv-chip-active/);
});

test('the point inspector shows a picked point normal', async ({ page }) => {
  await openFixture(page);
  // Let the framing tween settle so the click lands on the cloud.
  await page.waitForTimeout(1500);
  await page.locator('.olv-tool', { hasText: 'Inspect' }).click();
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const row = page.locator('.olv-inspect-row', {
    has: page.locator('.olv-inspect-row-label', { hasText: /^Normal$/ }),
  });
  await expect(async () => {
    await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
    await expect(row).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  // "x, y, z" of a unit vector tilted about y: the y component is zero.
  const text = (await row.locator('.olv-inspect-row-value').textContent()) ?? '';
  const [x, y, z] = text.split(',').map((v) => Number(v.trim()));
  expect(y).toBe(0);
  expect(Math.hypot(x, y, z)).toBeCloseTo(1, 3);
});
