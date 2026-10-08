/**
 * J1 Open a scan and know what it is, and J2 Understand scope and units.
 *
 * P1 opens the classified UTM fixture, P3 the LAZ with no CRS. The "Project
 * ready" card and the state strip are compared with the file's own header,
 * read here outside the app.
 */
import { test, expect, type Page } from '@playwright/test';
import { parseLasHeader } from '../../../src/io/lasHeader';
import { fixtureBytes, openWith, startJourney } from './helpers/journey';
import { showWorkspaceMode } from '../helpers';

/** First frame budget for a sub-megabyte file on a CI software renderer. */
const FIRST_FRAME_BUDGET_MS = 15_000;

function header(bytes: Uint8Array) {
  return parseLasHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

/** The card's label/value rows as a record. */
async function cardRows(page: Page): Promise<Record<string, string>> {
  const card = page.locator('.olv-project-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  // The card mounts before its rows are filled in.
  await expect(card.locator('.olv-pc-name')).not.toHaveText('', { timeout: 10_000 });
  await expect(card.locator('.olv-pc-row').first()).toBeVisible();
  return card.evaluate((el) => {
    const out: Record<string, string> = {};
    for (const row of el.querySelectorAll('.olv-pc-row')) {
      out[row.querySelector('.olv-pc-label')?.textContent ?? ''] = row.querySelector('.olv-pc-value')?.textContent ?? '';
    }
    out.__name = el.querySelector('.olv-pc-name')?.textContent ?? '';
    return out;
  });
}

/** "900" or "120.0K", as the card prints a count. */
function cardCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

const strip = (page: Page) => page.locator('.olv-state-strip');

test.describe('J1 open a scan and know what it is', () => {
  test('P1: a classified UTM LAS states its size, attributes and CRS', async ({ page }, info) => {
    const j = startJourney(page, info, 'j1');
    const bytes = fixtureBytes('terrain-access-utm.las');
    const h = header(bytes);

    const elapsed = await j.step('drop the file and wait for the first frame', () => openWith(page, bytes, 'terrain-access-utm.las'));
    expect(elapsed, 'first frame within budget').toBeLessThan(FIRST_FRAME_BUDGET_MS);

    await j.step('read the Project ready card', async () => {
      const rows = await cardRows(page);
      expect(rows.__name).toBe('terrain-access-utm.las');
      expect(rows.Format).toBe('LAS');
      expect(rows.Points).toBe(cardCount(h.pointCount));
      const ext = [0, 1, 2].map((a) => (h.max[a] - h.min[a]).toFixed(1));
      expect(rows.Size).toBe(`${ext[0]} × ${ext[1]} × ${ext[2]} m`);
      expect(rows.Attributes).toContain('Classification');
    });

    await j.step('read the state strip', async () => {
      await expect(strip(page)).toBeVisible();
      await expect(strip(page).locator('.olv-ss-crs')).toContainText('EPSG:32613');
      await expect(strip(page).locator('.olv-ss-crs')).toContainText('metres');
      await expect(strip(page).locator('.olv-ss-vertical')).toHaveText(/Vertical: unknown/);
      await expect(strip(page).locator('.olv-ss-basis')).toHaveText(/Full dataset/);
    });
  });

  test('P3: a LAZ with no CRS says so and claims no metres', async ({ page }, info) => {
    const j = startJourney(page, info, 'j1');
    const bytes = fixtureBytes('multichunk.laz');
    const h = header(bytes);

    await j.step('drop the LAZ', () => openWith(page, bytes, 'multichunk.laz'));

    await j.step('card shows the declared count in source units', async () => {
      const rows = await cardRows(page);
      expect(rows.Format).toBe('LAZ');
      expect(rows.Points).toBe(cardCount(h.pointCount));
      expect(rows.Size).toMatch(/source units$/);
      expect(rows.Size).not.toMatch(/\bm$/);
    });

    await j.step('strip says CRS unknown and Vertical: unknown', async () => {
      await expect(strip(page).locator('.olv-ss-crs')).toContainText('CRS unknown');
      await expect(strip(page).locator('.olv-ss-vertical')).toHaveText(/Vertical: unknown/);
    });
  });
});

test.describe('J2 understand scope and units', () => {
  test('P2: Coordinate system section and point basis match the header', async ({ page }, info) => {
    test.skip(test.info().project.use.hasTouch === true, 'desktop rail journey');
    const j = startJourney(page, info, 'j2');
    const bytes = fixtureBytes('terrain-access-utm.las');
    await j.step('open the UTM scan', () => openWith(page, bytes, 'terrain-access-utm.las'));

    await j.step('the CRS item opens the coordinate system in Data', async () => {
      await strip(page).locator('.olv-ss-crs').click();
      await expect(page.locator('.olv-ws-tab[data-mode="data"]')).toHaveAttribute('aria-selected', 'true');
      const crs = page.locator('details', { has: page.locator('summary', { hasText: 'Coordinate system' }) }).first();
      await expect(crs).toBeVisible();
      if (!(await crs.evaluate((d) => (d as HTMLDetailsElement).open))) await crs.locator('summary').click();
      await expect(crs.locator('summary + *').first()).toContainText('EPSG:32613');
      await expect(crs).toContainText('Source: LAS / LAZ georeference VLR');
      // The unit and the vertical reference are stated on the strip, which
      // stays on screen beside the section.
      await expect(strip(page).locator('.olv-ss-crs')).toContainText('metres');
      await expect(strip(page).locator('.olv-ss-vertical')).toHaveAttribute('aria-label', /Vertical: unknown/);
    });

    await j.step('the point basis says full dataset for a fully loaded file', async () => {
      await expect(strip(page).locator('.olv-ss-basis')).toHaveAttribute('aria-label', /Basis: Full dataset/);
    });
  });

  test('P1: on a scan with no CRS, no readout claims metres', async ({ page }, info) => {
    test.skip(test.info().project.use.hasTouch === true, 'desktop rail journey');
    const j = startJourney(page, info, 'j2');
    await j.step('open the LAZ with no CRS', () => openWith(page, fixtureBytes('multichunk.laz'), 'multichunk.laz'));
    await j.step('place a distance and read its unit', async () => {
      await page.locator('.olv-tool', { hasText: 'Measure' }).click();
      await page.evaluate(() => {
        const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind: (k: string) => void; placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void } }).__OLV_TEST_API__;
        api.setMeasureKind('distance');
        api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
        api.placeMeasurementPoint({ x: 3, y: 4, z: 0 });
      });
      const row = page.locator('.olv-mp-row').first();
      await expect(row).toBeVisible({ timeout: 5_000 });
      const text = (await row.innerText()).replace(/\s+/g, ' ');
      expect(text, `measurement row: ${text}`).toMatch(/^5(\.0+)? \(unit unverified\)/);
      expect(text, `measurement row claims metres on a file with no CRS: ${text}`).not.toMatch(/\d\s?m\b/);
    });
    await j.step('the Data panel names the basis', async () => {
      await showWorkspaceMode(page, 'data');
      await expect(strip(page).locator('.olv-ss-basis')).toBeVisible();
    });
  });
});

/** Journal entries in IndexedDB, as file names. */
const journalNames = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open('olv-recovery', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('entries', { keyPath: 'key' });
        open.onsuccess = () => {
          const get = open.result.transaction('entries', 'readonly').objectStore('entries').getAll();
          get.onsuccess = () => {
            open.result.close();
            resolve((get.result as Array<{ fileName: string }>).map((e) => e.fileName));
          };
        };
        open.onerror = () => resolve([]);
      }),
  );

/** Transient cards on screen now: Project card, toast, recovery notice, touch hint. */
const shownTransients = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.olv-project-card.olv-visible, .olv-lasso-toast.olv-visible, .olv-recovery-notice, .olv-touch-hint.olv-visible')]
      .filter((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && r.width > 0 && r.height > 0;
      })
      .map((el) => String(el.className).split(' ')[0]),
  );

/**
 * Share of the viewport where the scan shows: a 24 x 52 grid of points, each
 * counted when the topmost element there is the WebGL canvas.
 */
const scanVisibleShare = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const cols = 24, rows = 52;
    let hit = 0;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const el = document.elementFromPoint(((i + 0.5) / cols) * innerWidth, ((j + 0.5) / rows) * innerHeight);
        if (el instanceof HTMLCanvasElement) hit++;
      }
    }
    return hit / (cols * rows);
  });

test.describe('J1 phone first open', () => {
  test.skip(() => test.info().project.use.hasTouch !== true, 'phone journey runs on webkit-mobile');

  test('P3: after opening a scan, one transient card shows and the scan fills at least 60% of the screen', async ({ page }, info) => {
    test.setTimeout(120_000);
    const j = startJourney(page, info, 'j1');
    await j.step('leave unsaved work on another file', async () => {
      await openWith(page, fixtureBytes('terrain-access-utm.las'), 'terrain-access-utm.las');
      await page.evaluate(() => {
        const api = (window as unknown as { __OLV_TEST_API__: { setMeasureMode: (on: boolean) => void; setMeasureKind: (k: string) => void; placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void } }).__OLV_TEST_API__;
        api.setMeasureMode(true);
        api.setMeasureKind('distance');
        api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
        api.placeMeasurementPoint({ x: 3, y: 4, z: 0 });
        api.setMeasureMode(false);
      });
      await expect.poll(() => page.evaluate(() => (window as unknown as { __OLV_TEST_API__: { getMeasurementCount: () => number } }).__OLV_TEST_API__.getMeasurementCount())).toBe(1);
      // A pointer or key event arms the journal write (recoveryController.ts).
      await expect.poll(async () => {
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' })));
        return journalNames(page);
      }, { timeout: 20_000, intervals: [4_000] }).toContain('terrain-access-utm.las');
    });
    await j.step('open the LAZ with no CRS', () => openWith(page, fixtureBytes('multichunk.laz'), 'multichunk.laz'));
    await j.step('the screen right after open', async () => {
      await expect(page.locator('.olv-project-card.olv-visible')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.olv-recovery-notice')).toHaveCount(1, { timeout: 10_000 });
      await page.waitForTimeout(500);
      const shown = await shownTransients(page);
      expect(shown, `transient cards on screen: ${shown.join(', ')}`).toHaveLength(1);
      const share = await scanVisibleShare(page);
      await info.attach('scan-visible-share.txt', { body: share.toFixed(3), contentType: 'text/plain' });
      expect(share, 'share of the screen showing the scan').toBeGreaterThanOrEqual(0.6);
    });
    await j.step('a touch on the scan dismisses the Project card and the next card shows', async () => {
      const box = (await page.locator('canvas').first().boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);
      await expect(page.locator('.olv-project-card.olv-visible')).toHaveCount(0);
      await expect.poll(() => shownTransients(page)).toHaveLength(1);
    });
  });
});
