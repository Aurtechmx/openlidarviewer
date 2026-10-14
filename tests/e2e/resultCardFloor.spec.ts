import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, openToolPage } from './helpers';

/**
 * The latest-result card grows with its caveat lines. However tall it gets, it
 * must end above the active tool's pill and scroll inside itself, so the
 * pill's Finish and Cancel stay reachable.
 */
async function commitBox(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openToolPage(page, 'Measure');
  await page.waitForFunction(() => !!(window as unknown as { __OLV_TEST_API__?: unknown }).__OLV_TEST_API__);
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: {
      setMeasureMode: (on: boolean) => void;
      setMeasureKind: (k: string) => void;
      placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
    } }).__OLV_TEST_API__;
    api.setMeasureMode(true);
    api.setMeasureKind('box');
    api.placeMeasurementPoint({ x: 2, y: 2, z: 2 });
    api.placeMeasurementPoint({ x: -2, y: -2, z: -2 });
    // Stay in Measure so the active-tool pill shows.
    api.setMeasureMode(true);
  });
}

for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 720 }]) {
  test(`${size.width}x${size.height}: a tall result card ends above the tool pill and scrolls`, async ({ page }) => {
    await page.setViewportSize(size);
    await commitBox(page);
    const card = page.locator('.olv-result-card:not(.olv-hidden)');
    const pill = page.locator('.olv-ati:not(.olv-hidden)');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(pill).toBeVisible({ timeout: 10_000 });
    // Make the card far taller than the stage, as long caveat text can.
    await page.evaluate(() => {
      const c = document.querySelector('.olv-result-card:not(.olv-hidden)')!;
      const filler = document.createElement('div');
      filler.className = 'olv-result-caveat';
      filler.style.height = '2000px';
      filler.style.flex = 'none';
      c.appendChild(filler);
    });
    await expect.poll(async () => {
      const cb = await card.boundingBox();
      const pb = await pill.boundingBox();
      return cb && pb ? Math.round(cb.y + cb.height - pb.y) : 9999;
    }, { timeout: 5_000 }).toBeLessThanOrEqual(0);
    // The overflow scrolls inside the card instead of spilling over the stage.
    expect(await card.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto')).toBe(true);
    // The pill's Cancel is the element actually under its own centre.
    const cancel = pill.locator('.olv-ati-cancel');
    const cb = (await cancel.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.olv-ati-cancel') !== null, [cb.x + cb.width / 2, cb.y + cb.height / 2]);
    expect(hit).toBe(true);
  });
}
