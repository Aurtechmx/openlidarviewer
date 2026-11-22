import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { dropDenseGridUtmLas, openAnalysePanel, placeProfile } from './helpers';

/**
 * The profile sheet in the session's sheet style (Light by default): sheet one
 * embeds the corridor's returns as an image, and the plan strip when a fresh
 * terrain analysis of the same scan exists. The returns are only put on the
 * sheet when they sit on the ground line they were sampled into, so a returns
 * image in the file shows the two were read in one frame.
 */

/** Base font names and image count of a PDF, object streams included. */
async function pdfResources(bytes: Buffer): Promise<{ fonts: string[]; images: number; pages: number }> {
  const doc = await PDFDocument.load(bytes);
  const fonts: string[] = [];
  // A PNG with transparency is two image objects, the picture and its alpha
  // mask; count the pictures (the ones that carry a mask).
  let images = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    if (dict.get(PDFName.of('Type')) === PDFName.of('Font')) {
      const base = dict.get(PDFName.of('BaseFont'));
      if (base instanceof PDFName) fonts.push(base.decodeText());
    }
    if (dict.get(PDFName.of('Subtype')) === PDFName.of('Image') && dict.get(PDFName.of('SMask'))) images++;
  }
  return { fonts, images, pages: doc.getPageCount() };
}

async function exportProfilePdf(page: Page): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.locator('.olv-mp-profile-pdf', { hasText: 'Export PDF' }).first().click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  return readFileSync((await download.path())!);
}

test('a styled profile sheet embeds the returns, and the plan strip after a terrain run', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?test=1');
  await dropDenseGridUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ })).toBeEnabled({ timeout: 20_000 });
  await openAnalysePanel(page);
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind(k: string): void; placeMeasurementPoint(p: { x: number; y: number; z: number }): void; finishMeasurement?(): void } }).__OLV_TEST_API__;
    api.setMeasureKind('profile');
    api.placeMeasurementPoint({ x: -4, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 4, y: 0, z: 0 });
    api.finishMeasurement?.();
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
  const res = await pdfResources(await exportProfilePdf(page));
  expect(res.fonts.some((f) => f.includes('Figtree'))).toBe(true);
  // The plan strip's relief and the returns.
  expect(res.images).toBe(2);
  expect(res.pages).toBeGreaterThan(2);
});

test('a styled profile sheet on a scan opened fresh draws the returns', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?test=1');
  await dropDenseGridUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind(k: string): void; placeMeasurementPoint(p: { x: number; y: number; z: number }): void; finishMeasurement?(): void } }).__OLV_TEST_API__;
    api.setMeasureKind('profile');
    api.placeMeasurementPoint({ x: -4, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 4, y: 0, z: 0 });
    api.finishMeasurement?.();
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
  const res = await pdfResources(await exportProfilePdf(page));
  expect(res.fonts.some((f) => f.includes('Figtree'))).toBe(true);
  // The returns, and the plan strip too if the app already holds a fresh analysis of the scan.
  expect(res.images).toBeGreaterThanOrEqual(1);
});

test('a profile with no ground in its corridor exports without returns', async ({ page }) => {
  test.setTimeout(120_000);
  await placeProfile(page);
  const res = await pdfResources(await exportProfilePdf(page));
  expect(res.pages).toBeGreaterThan(1);
  expect(res.images).toBe(0);
});
