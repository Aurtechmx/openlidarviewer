import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, dropTinyPly } from './helpers';

/**
 * Session recovery: work journaled to IndexedDB survives a reload and is
 * offered back only when the same source is reopened.
 */

type Pose = { position: [number, number, number]; target: [number, number, number] };
type Api = {
  setMeasureKind: (k: string) => void;
  placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
  getMeasurementCount: () => number;
  getCameraPose: () => Pose;
};

const placeDistance = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const a = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    a.setMeasureKind('distance');
    a.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
    a.placeMeasurementPoint({ x: 1, y: 0.5, z: 0.25 });
  });
const measurementCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.getMeasurementCount());
const cameraPose = (page: Page): Promise<Pose> =>
  page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.getCameraPose());

/** Journal entries currently in IndexedDB, as `[fileName, measurements]`. */
const journal = (page: Page): Promise<Array<[string, number]>> =>
  page.evaluate(
    () =>
      new Promise<Array<[string, number]>>((resolve) => {
        const open = indexedDB.open('olv-recovery', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('entries', { keyPath: 'key' });
        open.onsuccess = () => {
          const get = open.result.transaction('entries', 'readonly').objectStore('entries').getAll();
          get.onsuccess = () => {
            const rows = (get.result as Array<{ fileName: string; measurements: number }>).map((e) => [e.fileName, e.measurements] as [string, number]);
            open.result.close();
            resolve(rows);
          };
        };
        open.onerror = () => resolve([]);
      }),
  );

async function openTiny(page: Page): Promise<void> {
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

/** Open tiny.ply, place one distance, move the camera, and wait for the journal write. */
async function journalWork(page: Page): Promise<Pose> {
  await page.goto('/?test=1');
  await openTiny(page);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await placeDistance(page);
  await expect.poll(() => measurementCount(page)).toBe(1);
  await page.keyboard.press('Escape');
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(600);
  // Any interaction re-arms the debounce; the last one is the wheel above.
  await page.mouse.wheel(0, 1);
  await expect.poll(() => journal(page), { timeout: 15_000 }).toEqual([['tiny.ply', 1]]);
  return cameraPose(page);
}

test('reload, reopen the same file, restore: measurement and camera come back', async ({ page }) => {
  const saved = await journalWork(page);
  await page.reload();
  const notice = page.locator('.olv-recovery-notice');
  await expect(notice).toContainText('Unsaved work found');
  await expect(notice).toContainText('1 measurement on tiny.ply');

  await openTiny(page);
  expect(await measurementCount(page)).toBe(0);
  // The reopen frames the scan afresh, so the saved pose is not already in place.
  const fresh = await cameraPose(page);
  expect(Math.max(...fresh.position.map((v, i) => Math.abs(v - saved.position[i])))).toBeGreaterThan(1e-3);
  await notice.getByRole('button', { name: 'Restore previous work' }).click();
  await expect(notice).toBeHidden();
  await expect.poll(() => measurementCount(page)).toBe(1);
  await expect
    .poll(async () => {
      const p = await cameraPose(page);
      return Math.max(...p.position.map((v, i) => Math.abs(v - saved.position[i])), ...p.target.map((v, i) => Math.abs(v - saved.target[i])));
    }, { timeout: 10_000 })
    .toBeLessThan(1e-3);
});

test('reopening a different file offers no restore', async ({ page }) => {
  await journalWork(page);
  await page.reload();
  const notice = page.locator('.olv-recovery-notice');
  await expect(notice).toContainText('Unsaved work found');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(notice).toContainText('differs from tiny.ply');
  await expect(notice.getByRole('button', { name: 'Restore previous work' })).toHaveCount(0);
  expect(await measurementCount(page)).toBe(0);
  // The saved work is kept for the right file.
  expect(await journal(page)).toEqual([['tiny.ply', 1]]);
});

test('an entry older than seven days is deleted and not offered; Clear removes the offer', async ({ page }) => {
  await journalWork(page);
  // Age the saved entry past the seven-day limit.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const open = indexedDB.open('olv-recovery', 1);
        open.onsuccess = () => {
          const store = open.result.transaction('entries', 'readwrite').objectStore('entries');
          const get = store.getAll();
          get.onsuccess = () => {
            for (const e of get.result as Array<{ savedAt: number }>) store.put({ ...e, savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
            store.transaction.oncomplete = () => { open.result.close(); resolve(); };
          };
        };
      }),
  );
  await page.reload();
  await expect.poll(() => journal(page), { timeout: 10_000 }).toEqual([]);
  await expect(page.locator('.olv-recovery-notice')).toHaveCount(0);

  // Fresh work, then Clear from the notice.
  await journalWork(page);
  await page.reload();
  const notice = page.locator('.olv-recovery-notice');
  await expect(notice).toContainText('Unsaved work found');
  await notice.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(notice).toContainText('Recovery data in this browser was deleted.');
  await expect.poll(() => journal(page)).toEqual([]);
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator('.olv-recovery-notice')).toHaveCount(0);
});
