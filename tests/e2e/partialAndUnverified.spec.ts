import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { railChromeSettled, showWorkspaceMode } from './helpers';
import { dropBytes, geomFixtures } from './geomFixtures';

/**
 * A truncated LAS reads as partial wherever coverage is reported, and a scan
 * with no CRS never shows its measurements as metres.
 */

interface Api {
  setMeasureKind(k: string): void;
  placeMeasurementPoint(p: { x: number; y: number; z: number }): void;
}

async function placeDistance(page: Page, a: number[], b: number[]): Promise<void> {
  if (!(await page.locator('.olv-measure-bar').isVisible())) await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
  await page.evaluate(({ a, b }) => {
    const api = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: a[0], y: a[1], z: a[2] });
    api.placeMeasurementPoint({ x: b[0], y: b[1], z: b[2] });
  }, { a, b });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
}

async function exportFile(page: Page, label: 'GeoJSON' | 'CSV'): Promise<string> {
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  const head = panel.locator('.olv-export-products-head');
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  const wait = page.waitForEvent('download');
  await panel.locator('.olv-export-product-actions button', { hasText: new RegExp(`^${label}$`) }).click();
  return readFileSync((await (await wait).path())!, 'utf8');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
});

const TRUNCATED = 'Truncated: 4 of 2,601 points read';

test('a truncated LAS opens as partial, with the count it read', async ({ page }) => {
  const fx = await geomFixtures();
  await dropBytes(page, fx.broken, 'broken.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });

  await expect(page.locator('.olv-project-card')).toContainText(TRUNCATED);
  const basis = page.locator('.olv-state-strip .olv-ss-basis');
  await expect(basis).toBeVisible();
  await expect(basis).not.toContainText('Full dataset');
  await expect(basis).toContainText('Partial');

  await showWorkspaceMode(page, 'data');
  await railChromeSettled(page);
  await expect(page.locator('.olv-layerhealth-layer')).toContainText(TRUNCATED, { timeout: 20_000 });

  await placeDistance(page, [0, 0, 0], [1, 0, 0]);
  const fc = JSON.parse(await exportFile(page, 'GeoJSON')) as { provenance: { dataBasis: string; coverageNote?: string } };
  expect(fc.provenance.dataBasis).toBe('partial');
  expect(fc.provenance.coverageNote).toBe(TRUNCATED);
});

test('a scan with no CRS shows its measurements as unit unverified, not metres', async ({ page }) => {
  const fx = await geomFixtures();
  await dropBytes(page, fx.geomNoCrs, 'geom-nocrs.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  // 3 east and 4 north: a 5-unit line.
  await placeDistance(page, [4, 2, 1], [7, 6, 1]);

  const row = page.locator('.olv-mp-row').first();
  await expect(row).toContainText('5 (unit unverified)');
  expect(await row.textContent()).not.toMatch(/\d\s?(m|cm|km|ft)\b/);
  const conf = page.locator('.olv-mp-confidence').first();
  await expect(conf).not.toContainText('datum resolved');
  const breakdown = page.locator('.olv-mp-breakdown').first();
  await expect(breakdown).toContainText('(unit unverified)');
  expect(await breakdown.textContent()).not.toMatch(/\d\s?(m|cm|km|ft)\b/);
  await expect(page.locator('.olv-measure-hint-text:visible')).toContainText('unit unverified');

  const csv = await exportFile(page, 'CSV');
  const [header, line] = csv.split('\n');
  expect(header).toContain('length_source');
  expect(header).not.toContain('length_m');
  expect(line).toContain('units-unverified');
});

test('a profile on a scan with no CRS labels its chart, summary and workbench as unit unverified', async ({ page }) => {
  const fx = await geomFixtures();
  await dropBytes(page, fx.geomNoCrs, 'geom-nocrs.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  if (!(await page.locator('.olv-measure-bar').isVisible())) await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: Api & { finishMeasurement(): void } }).__OLV_TEST_API__;
    api.setMeasureKind('profile');
    api.placeMeasurementPoint({ x: 2, y: 5, z: 1 });
    api.placeMeasurementPoint({ x: 30, y: 5, z: 1 });
    api.finishMeasurement();
  });
  await expect(page.locator('.olv-mp-chart-wrap').first()).toBeVisible({ timeout: 10_000 });
  const metric = /\d\s?(m|km|ft|mi)\b/;
  const panel = page.locator('.olv-measure-panel');
  await expect(panel).toContainText('unit unverified');
  expect(await panel.innerText()).not.toMatch(metric);

  await page.locator('.olv-mp-chart-wrap').first().click();
  const detail = page.locator('.olv-workbench-detail');
  await expect(page.locator('.olv-workbench-detail-row').first()).toBeVisible({ timeout: 10_000 });
  await expect(detail).toContainText('unit unverified');
  expect(await detail.innerText()).not.toMatch(metric);
});
