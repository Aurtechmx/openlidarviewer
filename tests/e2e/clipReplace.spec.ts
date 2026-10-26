import { test, expect, type Page } from '@playwright/test';
import { dropTinyLas, openExpandedPanel, openToolPage, waitForLoadIdle } from './helpers';
import { COPC_FIXTURE } from './streamingFixtures';

/**
 * A scan that replaces the open one starts without the old clip box: the box
 * was drawn around the previous scan and would cut the new one arbitrarily.
 * A scan added beside the open ones keeps the box, since the scene it clips
 * is still there.
 */

type ClipState = { clip: { enabled: boolean } | null };

const clipState = (page: Page): Promise<ClipState | null> =>
  page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__?: { getClipState: () => ClipState } }).__OLV_TEST_API__;
    return api ? api.getClipState() : null;
  });

const staticLayerCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__?: { layerClassStates: () => unknown[] } }).__OLV_TEST_API__;
    return api ? api.layerClassStates().length : -1;
  });

async function turnClipOn(page: Page): Promise<void> {
  const panel = page.locator('.olv-clip-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  await panel.locator('label', { hasText: 'Clip the scan to this box' }).click();
  await expect.poll(async () => (await clipState(page))?.clip?.enabled ?? false, { timeout: 10_000 }).toBe(true);
}

async function openCopc(page: Page): Promise<void> {
  await waitForLoadIdle(page);
  await page.locator('.olv-file-input').first().setInputFiles(COPC_FIXTURE);
  const streaming = page.locator('.olv-streaming-panel');
  await expect(streaming).toBeVisible({ timeout: 30_000 });
  await expect(streaming).toContainText('Current view ready', { timeout: 30_000 });
}

test('a stream that replaces a clipped static scan opens unclipped', async ({ page }) => {
  await openExpandedPanel(page, 'work', '.olv-clip-panel');
  await turnClipOn(page);

  await openCopc(page);
  await expect.poll(() => staticLayerCount(page), { timeout: 20_000 }).toBe(0);
  await expect.poll(async () => (await clipState(page))?.clip ?? null, { timeout: 10_000 }).toBeNull();
});

test('a static scan that replaces a clipped stream opens unclipped', async ({ page }) => {
  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await openCopc(page);
  await openToolPage(page, 'Clip box');
  await turnClipOn(page);

  await dropTinyLas(page);
  await expect(page.locator('.olv-streaming-panel')).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => staticLayerCount(page), { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await clipState(page))?.clip ?? null, { timeout: 10_000 }).toBeNull();
});

test('a scan added beside a clipped one keeps the clip', async ({ page }) => {
  await openExpandedPanel(page, 'work', '.olv-clip-panel');
  await turnClipOn(page);

  await dropTinyLas(page);
  await expect.poll(() => staticLayerCount(page), { timeout: 20_000 }).toBe(2);
  await waitForLoadIdle(page);
  expect((await clipState(page))?.clip?.enabled).toBe(true);
});
