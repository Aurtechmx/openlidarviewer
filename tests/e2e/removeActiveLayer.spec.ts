import { test, expect, type Page } from '@playwright/test';
import { dropTerrainAccessUtmLas, dropTinyPly, showWorkspaceMode } from './helpers';

/**
 * Removing the active layer while another stays open.
 *
 * Layer A (terrain-access-utm.las, UTM zone 13N) is opened first, then layer B
 * (tiny.ply, no CRS) over it, so B is active. Removing B must make A active
 * through the normal activation path: the export frame names A and the
 * resolved CRS is A's again. Removing a layer that is not active keeps the
 * active one.
 */

interface ActiveScan {
  activeName: string | null;
  geo: { name: string | null; origin: readonly number[]; epsg: number | null } | null;
}

const activeScan = (page: Page) => page.evaluate(() => (window as unknown as { __OLV_TEST_API__: { activeScan: () => ActiveScan } }).__OLV_TEST_API__.activeScan());

async function utmThenPly(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropTerrainAccessUtmLas(page);
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(async () => (await activeScan(page)).geo?.epsg, { timeout: 10_000 }).toBe(32613);
  await dropTinyPly(page);
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  const before = await activeScan(page);
  expect(before.activeName).toBe('tiny.ply');
  expect(before.geo?.name).toBe('tiny.ply');
  expect(before.geo?.epsg).toBeNull();
  await showWorkspaceMode(page, 'data');
}

test('removing the active layer makes the remaining layer active, with its frame and CRS', async ({ page }) => {
  await utmThenPly(page);
  await page.locator('.olv-layer', { hasText: 'tiny' }).locator('.olv-layer-x').click();
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 10_000 });
  const after = await activeScan(page);
  expect(after.activeName).toBe('terrain-access-utm.las');
  expect(after.geo?.name).toBe('terrain-access-utm.las');
  expect(after.geo?.epsg).toBe(32613);
  expect(after.geo?.origin).not.toEqual([0, 0, 0]);
});

test('removing a layer that is not active keeps the active layer', async ({ page }) => {
  await utmThenPly(page);
  await page.locator('.olv-layer', { hasText: 'terrain-access' }).locator('.olv-layer-x').click();
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 10_000 });
  const after = await activeScan(page);
  expect(after.activeName).toBe('tiny.ply');
  expect(after.geo?.name).toBe('tiny.ply');
  expect(after.geo?.epsg).toBeNull();
});
