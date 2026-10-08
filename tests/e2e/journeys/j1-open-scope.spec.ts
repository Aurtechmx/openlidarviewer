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
    // multichunk.laz is 120 000 points of LAZ; on a CI software renderer the
    // open alone took 30 s, past the default test timeout.
    test.setTimeout(120_000);
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
    // multichunk.laz is 120 000 points of LAZ; on a CI software renderer the
    // open alone took 30 s, past the default test timeout.
    test.setTimeout(120_000);
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
