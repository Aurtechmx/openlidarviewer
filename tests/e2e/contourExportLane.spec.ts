import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dropTinyLas, openAnalysePage, openAnalysePanel, showWorkspaceMode } from './helpers';

/**
 * The Export mode's terrain lane: "Contour map sheet (PDF)" writes the same
 * map sheet the Contour Studio PDF export writes, and a product that cannot
 * run says why instead of doing nothing.
 */

/** Record the type and size of every blob handed to a download link. */
async function recordBlobs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: { type: string; size: number }[] = [];
    (window as unknown as { __olvBlobs: typeof seen }).__olvBlobs = seen;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource): string => {
      if (obj instanceof Blob) seen.push({ type: obj.type, size: obj.size });
      return create(obj);
    };
  });
}

/**
 * A 60 by 60 grid over 10 m with 1.5 m of relief, as a LAS 1.4 in EPSG:32633
 * with a NAVD88 metre vertical axis: dense enough, and with enough relief, for
 * the contour exports to open.
 */
async function dropReliefUtmLas(page: Page): Promise<void> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
  };
  const { writeLas14 } = await import('../../src/convert/writeLas');
  const { wktForEpsg } = await import('../../src/io/epsgWkt');
  const N = 60;
  const x = new Float64Array(N * N);
  const y = new Float64Array(N * N);
  const z = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) {
    const u = Math.floor(k / N) / (N - 1);
    const v = (k % N) / (N - 1);
    x[k] = 500_000 + u * 10;
    y[k] = 5_000_000 + v * 10;
    z[k] = 200 + Math.sin(u * Math.PI) * Math.cos(v * Math.PI) * 1.5;
  }
  const bytes = writeLas14({ count: N * N, x, y, z }, {
    wkt: wktForEpsg(32633), epsg: 32633, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9001,
  });
  const dt = await page.evaluateHandle((b) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(b)], 'relief-utm.las'));
    return d;
  }, [...bytes]);
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

async function analyseFixture(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropReliefUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ })).toBeEnabled({ timeout: 20_000 });
  await openAnalysePanel(page);
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 30_000 });
}

function contourGroup(page: Page) {
  return page.locator('.olv-export-product-group[data-product="contours"]');
}

async function openContourLane(page: Page) {
  await showWorkspaceMode(page, 'output');
  const group = contourGroup(page);
  await expect(group).toBeVisible({ timeout: 20_000 });
  return group;
}

test('Export mode: the contour map sheet button downloads the PDF', async ({ page }) => {
  test.setTimeout(120_000);
  await recordBlobs(page);
  await analyseFixture(page);
  const group = await openContourLane(page);
  const btn = group.getByRole('button', { name: 'Contour map sheet (PDF)' });
  await expect(btn).toBeEnabled();
  await btn.click();

  const dialog = page.locator('.olv-modal[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    dialog.getByRole('button', { name: 'Export PDF' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const path = await download.path();
  if (!path) throw new Error('download produced no local path');
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(4_000);
  await expect(dialog).toBeHidden();
  const blobs = await page.evaluate(() => (window as unknown as { __olvBlobs: { type: string; size: number }[] }).__olvBlobs);
  expect(blobs.some((b) => b.type === 'application/pdf' && b.size === bytes.length)).toBe(true);
  await expect(group.locator('.olv-export-fullres-hint')).toHaveText('');

  // The Contour Studio PDF of the same scan, with the Studio's starting
  // purpose, is the same sheet: only the generated time differs.
  await openAnalysePage(page, 'contours');
  const launch = page.locator('.olv-analyse-contour-launcher .olv-contour-launcher-action');
  await expect(launch).toBeVisible({ timeout: 20_000 });
  await launch.click();
  await page.locator('.olv-cs-export-btn', { hasText: /^PDF$/ }).click();
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const [studio] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    dialog.getByRole('button', { name: 'Export PDF' }).click(),
  ]);
  const studioBytes = readFileSync((await studio.path())!);
  expect(Math.abs(studioBytes.length - bytes.length)).toBeLessThan(bytes.length * 0.02);
});

test('Export mode: a map sheet that cannot be written says why', async ({ page }) => {
  test.setTimeout(120_000);
  await analyseFixture(page);
  // A second scan becomes active; the analysis belongs to the first one.
  await dropTinyLas(page);
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  const group = await openContourLane(page);
  const btn = group.getByRole('button', { name: 'Contour map sheet (PDF)' });
  if (await btn.isEnabled()) await btn.click();
  const hint = group.locator('.olv-export-fullres-hint');
  await expect(hint).toContainText(/different scan/i);
  await expect(page.locator('.olv-modal[role="dialog"]')).toHaveCount(0);
});

test('Export mode: the DEM package button downloads the ZIP', async ({ page }) => {
  test.setTimeout(120_000);
  await analyseFixture(page);
  await showWorkspaceMode(page, 'output');
  const group = page.locator('.olv-export-product-group[data-product="terrain-dem"]');
  const btn = group.getByRole('button', { name: 'DEM package (ZIP)' });
  await expect(btn).toBeEnabled({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), btn.click()]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(bytes.length).toBeGreaterThan(1_000);
});
