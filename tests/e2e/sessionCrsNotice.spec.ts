import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { geomFixtures, dropBytes } from './geomFixtures';
import { openToolPage, showWorkspaceMode } from './helpers';

/**
 * A session that sets the coordinate system tells the user so, and the notice
 * is still on screen when the import has finished.
 *
 * A session is saved from a scan whose coordinate system the user confirmed
 * (EPSG:32613 over a scan that declares none), then opened in a new browser
 * context onto the same scan. Nothing from the first page survives but the
 * file. The toast that is left after the import names the coordinate system
 * and offers Keep; the restore toast used to replace the separate notice
 * before it could be read.
 */

type Api = {
  setMeasureKind(k: string): void;
  placeMeasurementPoint(p: { x: number; y: number; z: number; layer?: string }): void;
};

type Session = { crs?: { epsg?: number; userConfirmed?: boolean; source?: string } };

async function freshPage(browser: Browser, info: TestInfo): Promise<Page> {
  const use = info.project.use;
  const ctx = await browser.newContext({
    baseURL: use.baseURL,
    storageState: use.storageState,
    viewport: use.viewport ?? { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  await page.goto('/?test=1');
  return page;
}

test.describe('session coordinate-system notice', () => {
  test.describe.configure({ timeout: 180_000 });

  test('reopening a session with a confirmed CRS shows which one, with Keep, after the restore', async ({ browser }, info) => {
    const f = await geomFixtures();
    const scan = { bytes: f.geomNoCrs, name: 'geom-nocrs.las' };

    // Save: assign EPSG:32613 to a scan that declares no CRS, measure, export the session.
    const first = await freshPage(browser, info);
    await dropBytes(first, scan.bytes, scan.name);
    await expect(first.locator('.olv-layer')).toHaveCount(1, { timeout: 90_000 });
    await showWorkspaceMode(first, 'data');
    const crs = first.locator('summary', { hasText: 'Coordinate system' }).first();
    if (!(await crs.evaluate((s) => (s.parentElement as HTMLDetailsElement).open))) await crs.click();
    await first.locator('.olv-crs-select').first().selectOption('32613');
    await expect(first.locator('.olv-crs-epsg').first()).toHaveText('EPSG:32613');
    await openToolPage(first, 'Measure');
    await first.evaluate(() => {
      const api = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
      api.setMeasureKind('distance');
      api.placeMeasurementPoint({ x: 4, y: 2, z: 1 });
      api.placeMeasurementPoint({ x: 7, y: 6, z: 1 });
    });
    const download = first.waitForEvent('download');
    await first.locator('.olv-mp-action', { hasText: 'Export' }).click();
    const saved = readFileSync((await (await download).path())!, 'utf8');
    expect((JSON.parse(saved) as Session).crs).toMatchObject({ epsg: 32613, userConfirmed: true, source: 'user-override' });
    await first.context().close();

    // Restore: a new context, so no stored override survives; the same scan, then the session.
    const second = await freshPage(browser, info);
    await dropBytes(second, scan.bytes, scan.name);
    await expect(second.locator('.olv-layer')).toHaveCount(1, { timeout: 90_000 });
    await second.evaluate(async (text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'saved.olvsession'));
      document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, saved);

    // The restore finished: its toast is the one on screen, and it carries the notice.
    const toast = second.locator('.olv-lasso-toast.olv-visible');
    await expect(toast).toContainText(/restored/, { timeout: 60_000 });
    await expect(toast).toContainText('This session set the coordinate system to');
    await expect(toast).toContainText('EPSG:32613');
    await expect(toast).toContainText('not saved on this device');
    const keep = toast.getByRole('button', { name: 'Keep' });
    await expect(keep).toBeVisible();

    // Not stored until the user keeps it.
    const stored = (): Promise<number> => second.evaluate(() => {
      try { return (JSON.parse(localStorage.getItem('olv:crs-overrides') ?? '{"entries":[]}').entries ?? []).length; } catch { return 0; }
    });
    expect(await stored()).toBe(0);
    await keep.click();
    await expect.poll(stored).toBe(1);
    await second.context().close();
  });
});
