import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dropTinyPly, gotoSettled, openToolPage, reloadSettled, showWorkspaceMode, type MeasureTestApi } from './helpers';

/**
 * A session imported on an empty viewer keeps its annotations and views when
 * its scan is opened afterwards, and a second save still holds them.
 */

type Api = MeasureTestApi & { getMeasurementCount: () => number };
type Saved = { measurements: unknown[]; annotations: Array<{ title: string; localPosition: { x: number; y: number; z: number } }>; views: Array<{ name: string }> };


async function openTiny(page: Page): Promise<void> {
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

async function saveSession(page: Page): Promise<Saved> {
  await openToolPage(page, 'Measure');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.olv-mp-action', { hasText: 'Export' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.olvsession$/);
  const path = await download.path();
  if (!path) throw new Error('session download produced no local path');
  return JSON.parse(readFileSync(path, 'utf8')) as Saved;
}

const measurementCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.getMeasurementCount());

test('a session imported before its scan keeps its annotations and views when the scan opens', async ({ page }) => {
  test.slow();
  await gotoSettled(page, '/?test=1');
  await openTiny(page);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await page.evaluate(() => {
    const a = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    a.setMeasureKind('distance');
    a.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
    a.placeMeasurementPoint({ x: 1, y: 0.5, z: 0.25 });
  });
  await expect.poll(() => measurementCount(page)).toBe(1);
  await page.keyboard.press('Escape');
  const first = await saveSession(page);
  // One annotation and one saved view, added to the file the app wrote.
  const seeded = {
    ...first,
    annotations: [{ id: 'pending-note', title: 'Pending note', type: 'note', createdAt: 1, updatedAt: 1, localPosition: { x: 0.5, y: 0.25, z: 0.1 } }],
    views: [{ name: 'Pending view', camera: { position: [3, 3, 3], target: [0, 0, 0], mode: 'orbit' } }],
  };

  await reloadSettled(page);
  await expect(page.locator('.olv-empty')).toBeVisible();
  const dt = await page.evaluateHandle((t) => {
    const d = new DataTransfer();
    d.items.add(new File([t], 'pending.olvsession'));
    return d;
  }, JSON.stringify(seeded));
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await expect.poll(() => measurementCount(page), { timeout: 10_000 }).toBe(1);

  await openTiny(page);
  await showWorkspaceMode(page, 'work');
  await openToolPage(page, 'Annotate');
  await expect(page.locator('.olv-anno-panel .olv-ap-row', { hasText: 'Pending note' })).toHaveCount(1, { timeout: 10_000 });
  expect(await measurementCount(page)).toBe(1);

  const second = await saveSession(page);
  expect(second.measurements).toHaveLength(1);
  expect(second.annotations.map((a) => a.title)).toEqual(['Pending note']);
  expect(second.annotations[0]!.localPosition).toEqual({ x: 0.5, y: 0.25, z: 0.1 });
  expect(second.views.map((v) => v.name)).toEqual(['Pending view']);
});
