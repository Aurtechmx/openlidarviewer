/**
 * ceStrip.spec.ts — the scientific state strip (COMMUNITY_SPEC §9, CE-STRIP).
 *
 * On four fixtures each fact is visible in the strip without hover:
 *   • unknown vertical: a UTM LAS with no vertical datum
 *   • feet unit: the EVLR fixture with its WKT swapped for a US survey foot CRS
 *   • resident-only: the COPC fixture, streamed
 *   • stale: a terrain run made stale by a CRS override
 * Each item is a labelled button that opens where the fact is explained. At
 * 390 px the strip sits above the dock without overlapping it.
 *
 * With OLV_CE_SHOTS set to a directory, each fixture is also photographed at
 * desktop and phone size.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { dropTerrainAccessUtmLas, showWorkspaceMode, suppressOnboardingTour } from './helpers';
import { COPC_FIXTURE } from './streamingFixtures';

const SHOTS = process.env.OLV_CE_SHOTS;
const strip = (page: Page) => page.locator('.olv-state-strip');
const item = (page: Page, id: string) => strip(page).locator(`.olv-ss-${id}`);

const FEET_WKT =
  'PROJCS["NAD83 / Texas Central (ftUS)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","6269"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4269"]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["latitude_of_origin",29.6666666666667],PARAMETER["central_meridian",-100.333333333333],PARAMETER["standard_parallel_1",31.8833333333333],PARAMETER["standard_parallel_2",30.1166666666667],PARAMETER["false_easting",2296583.333],PARAMETER["false_northing",9842500],UNIT["US survey foot",0.304800609601219,AUTHORITY["EPSG","9003"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","2277"]]';

/** The EVLR fixture with its one CRS EVLR replaced by `wkt`. */
function lasWithWkt(wkt: string): Uint8Array {
  const src = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/evlr-crs-utm15.las', import.meta.url))));
  const start = Number(new DataView(src.buffer, src.byteOffset).getBigUint64(235, true));
  const payload = new Uint8Array(wkt.length + 1);
  for (let i = 0; i < wkt.length; i++) payload[i] = wkt.charCodeAt(i);
  const out = new Uint8Array(start + 60 + payload.length);
  out.set(src.subarray(0, start + 60), 0);
  new DataView(out.buffer).setBigUint64(start + 20, BigInt(payload.length), true);
  out.set(payload, start + 60);
  return out;
}

async function dropBytes(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  const dt = await page.evaluateHandle(
    ([b, n]) => {
      const t = new DataTransfer();
      t.items.add(new File([new Uint8Array(b as number[])], n as string));
      return t;
    },
    [[...bytes], name] as const,
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

async function start(page: Page): Promise<void> {
  await suppressOnboardingTour(page);
  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty')).toBeVisible();
}

async function loaded(page: Page): Promise<void> {
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await expect(strip(page)).toBeVisible({ timeout: 15_000 });
}

/** Every item reads as text on the strip, with no hover. */
async function expectAllFacts(page: Page): Promise<void> {
  for (const id of ['dataset', 'crs', 'vertical', 'basis', 'processing', 'review']) {
    const b = item(page, id);
    await expect(b).toBeVisible();
    await expect(b).toHaveAttribute('aria-label', /\S+: \S/);
    expect((await b.innerText()).trim().length).toBeGreaterThan(0);
  }
}

async function shoot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const FIXTURES: Record<string, (page: Page) => Promise<void>> = {
  'unknown-vertical': async (page) => {
    await dropBytes(page, new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/las-pdal/utm15.las', import.meta.url)))), 'utm15.las');
    await loaded(page);
    await expect(item(page, 'vertical')).toHaveText(/Vertical: unknown/);
  },
  'feet-unit': async (page) => {
    await dropBytes(page, lasWithWkt(FEET_WKT), 'texas-central-ftus.las');
    await loaded(page);
    await expect(item(page, 'crs')).toContainText('US survey ft');
    await expect(item(page, 'dataset')).toContainText('texas-central-ftus.las');
  },
  'resident-only': async (page) => {
    await page.locator('.olv-file-input').first().setInputFiles(COPC_FIXTURE);
    await loaded(page);
    await expect(item(page, 'basis')).toHaveText(/Resident only/);
  },
  stale: async (page) => {
    await dropTerrainAccessUtmLas(page);
    await loaded(page);
    await showWorkspaceMode(page, 'analyse');
    await page.locator('.olv-ah-row[data-analysis="terrain"] .olv-ah-open').click();
    await page.locator('.olv-analyse-run').click();
    await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, { timeout: 60_000 });
    const before = Number((await item(page, 'review').innerText()).match(/\d+/)?.[0] ?? 0);
    await showWorkspaceMode(page, 'data');
    await page.locator('summary', { hasText: 'Coordinate system' }).first().click();
    await page.locator('.olv-crs-select').first().selectOption('__local__');
    await expect
      .poll(async () => Number((await item(page, 'review').innerText()).match(/\d+/)?.[0] ?? 0), { timeout: 10_000 })
      .toBeGreaterThan(before);
  },
};

test.describe('state strip', () => {
  for (const [name, open] of Object.entries(FIXTURES)) {
    test(`${name}: every fact is visible without hover`, async ({ page }) => {
      test.setTimeout(name === 'stale' ? 150_000 : 60_000);
      await start(page);
      await open(page);
      await expectAllFacts(page);
      await shoot(page, `${name}-desktop`);
    });

    test(`${name}: phone, the strip sits above the dock`, async ({ page }) => {
      test.setTimeout(name === 'stale' ? 150_000 : 60_000);
      // The stale fixture runs terrain at desktop size, then narrows to a phone.
      if (name !== 'stale') await page.setViewportSize({ width: 390, height: 844 });
      await start(page);
      await open(page);
      if (name === 'stale') await page.setViewportSize({ width: 390, height: 844 });
      await expect(strip(page)).toBeVisible();
      await expectAllFacts(page);
      const s = await strip(page).boundingBox();
      const dock = await page.locator('.olv-dock').boundingBox();
      expect(s && dock).toBeTruthy();
      await shoot(page, `${name}-phone`);
      expect(s!.y + s!.height).toBeLessThanOrEqual(dock!.y + 0.5);
      expect(s!.x).toBeGreaterThanOrEqual(0);
      expect(s!.x + s!.width).toBeLessThanOrEqual(390 + 0.5);
    });
  }

  test('each item opens where its fact is explained', async ({ page }) => {
    test.setTimeout(60_000);
    await start(page);
    await FIXTURES['unknown-vertical']!(page);
    await item(page, 'review').click();
    await expect(page.locator('#olv-ws-mode-analyse .olv-analyse-home')).toBeVisible();
    await item(page, 'crs').click();
    await expect(page.locator('.olv-ws-tab[data-mode="data"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.olv-crs-summary').first()).toBeVisible({ timeout: 10_000 });
    // No toast or modal of its own (CE-STRIP-05).
    await expect(page.locator('[role="dialog"]:visible')).toHaveCount(0);
  });
});
