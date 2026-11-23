import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { dropDenseGridUtmLas, dropTinyLas, openAnalysePage, openAnalysePanel, showWorkspaceMode } from './helpers';

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

async function analyseFixture(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ })).toBeEnabled({ timeout: 20_000 });
  await openAnalysePanel(page);
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 30_000 });
}

/**
 * The text a PDF draws: every Flate content stream inflated, then its hex and
 * literal string operands decoded. Enough to compare two sheets' lines.
 */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let body: string;
    try {
      body = inflateSync(bytes.subarray(start, end)).toString('latin1');
    } catch {
      continue;
    }
    for (const h of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      out.push(Buffer.from(h[1].replace(/\s+/g, ''), 'hex').toString('latin1'));
    }
    for (const l of body.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(l[1]);
    re.lastIndex = end;
  }
  return out.join('\n');
}

/** Page count and the evidence and deliverable lines of one map sheet. */
async function sheetFacts(bytes: Buffer): Promise<{ pages: number; evidence: string[]; deliverable: string[] }> {
  const doc = await PDFDocument.load(bytes);
  const lines = pdfText(bytes).split('\n');
  return {
    pages: doc.getPageCount(),
    evidence: lines.filter((l) => l.startsWith('Evidence:')),
    deliverable: lines.filter((l) => l.startsWith('Deliverable - ')),
  };
}

/** Base font names and image count of a PDF, read through pdf-lib (object streams included). */
async function pdfResources(bytes: Buffer): Promise<{ fonts: string[]; images: number }> {
  const doc = await PDFDocument.load(bytes);
  const fonts: string[] = [];
  let images = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    const type = dict.get(PDFName.of('Type'));
    const sub = dict.get(PDFName.of('Subtype'));
    if (type === PDFName.of('Font')) {
      const base = dict.get(PDFName.of('BaseFont'));
      if (base instanceof PDFName) fonts.push(base.decodeText());
    }
    if (sub === PDFName.of('Image')) images++;
  }
  return { fonts, images };
}

/** The map sheet dialog's style picker: the select offering Classic. */
function styleSelect(dialog: Locator) {
  return dialog.locator('select', { has: dialog.page().locator('option[value="classic"]') });
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
  // Classic draws with the standard PDF fonts, whose text this test can read
  // back from the content streams. The choice carries to the Studio export below.
  await styleSelect(dialog).selectOption('classic');
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
  await openAnalysePage(page, 'contours'); // Make contours: Contour Studio opens
  await page.locator('.olv-cs-export-btn', { hasText: /^PDF$/ }).click({ timeout: 20_000 });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const [studio] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    dialog.getByRole('button', { name: 'Export PDF' }).click(),
  ]);
  const studioBytes = readFileSync((await studio.path())!);
  const lane = await sheetFacts(bytes);
  const viaStudio = await sheetFacts(studioBytes);
  expect(lane.pages).toBe(viaStudio.pages);
  expect(lane.evidence.length).toBeGreaterThan(0);
  expect(lane.evidence).toEqual(viaStudio.evidence);
  expect(lane.deliverable).toContain('Deliverable - Custom');
  expect(lane.deliverable).toEqual(viaStudio.deliverable);
  expect(Math.abs(studioBytes.length - bytes.length)).toBeLessThan(bytes.length * 0.005);
});

test('Export mode: the map sheet defaults to Light, with the relief and the sheet fonts embedded', async ({ page }) => {
  test.setTimeout(120_000);
  await analyseFixture(page);
  const group = await openContourLane(page);
  await group.getByRole('button', { name: 'Contour map sheet (PDF)' }).click();
  const dialog = page.locator('.olv-modal[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(styleSelect(dialog)).toHaveValue('light');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    dialog.getByRole('button', { name: 'Export PDF' }).click(),
  ]);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // The relief raster and Figtree, loaded from the build's own font files.
  const { fonts, images } = await pdfResources(bytes);
  expect(images).toBeGreaterThan(0);
  // Figures are set in Figtree too: no standard font stands in.
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.filter((f) => !f.includes('Figtree'))).toEqual([]);
  await expect(dialog).toBeHidden();

  // Dark is remembered for the next export in the session.
  await group.getByRole('button', { name: 'Contour map sheet (PDF)' }).click();
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await styleSelect(dialog).selectOption('dark');
  await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Export PDF' }).click()]);
  await expect(dialog).toBeHidden();
  await group.getByRole('button', { name: 'Contour map sheet (PDF)' }).click();
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(styleSelect(dialog)).toHaveValue('dark');
});

test('Export mode: the contour map PNG draws the sheet and carries its provenance', async ({ page }) => {
  test.setTimeout(120_000);
  await analyseFixture(page);
  await openContourLane(page);
  const lane = page.locator('.olv-export-product-group[data-product="contours-png"]');
  const btn = lane.getByRole('button', { name: 'Contour map (PNG)' });
  await expect(btn).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), btn.click()]);
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const bytes = readFileSync((await download.path())!);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  // Twice the SVG sheet's own size: well over a thousand pixels across.
  expect(bytes.readUInt32BE(16)).toBeGreaterThan(1000);
  const latin = bytes.toString('latin1');
  expect(latin).toContain('tEXtSoftware\0OpenLiDARViewer');
  expect(latin).toContain('tEXtDescription\0');
  await expect(lane.locator('.olv-export-fullres-hint')).toHaveText('');
});

test('Export mode: the map sheet offers the scan\'s measurements, checked', async ({ page }) => {
  test.setTimeout(120_000);
  await analyseFixture(page);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind(k: string): void; placeMeasurementPoint(p: { x: number; y: number; z: number }): void } }).__OLV_TEST_API__;
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 3, y: 4, z: 0 });
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
  const group = await openContourLane(page);
  await group.getByRole('button', { name: 'Contour map sheet (PDF)' }).click();
  const dialog = page.locator('.olv-modal[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const option = dialog.getByLabel('Include measurements');
  await expect(option).toBeChecked();
  await expect(option).toBeEnabled();
  await expect(dialog.getByText(/^1 measurement\. Light and Dark draw them lettered/)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Export PDF' }).click()]);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await expect(dialog).toBeHidden();
});

test('Export mode: the map sheet offers no work picked on another open scan', async ({ page }) => {
  test.setTimeout(180_000);
  const layers = page.locator('.olv-layer');
  await page.goto('/?test=1');
  await dropDenseGridUtmLas(page, { name: 'survey-b.las', dz: 3 });
  await expect(layers).toHaveCount(1, { timeout: 20_000 });
  // A opens second, so it is active while the distance is picked on B.
  await dropDenseGridUtmLas(page, { name: 'survey-a.las' });
  await expect(layers).toHaveCount(2, { timeout: 20_000 });
  const distanceOn = (layer: string) => page.evaluate((l) => {
    const api = (window as unknown as { __OLV_TEST_API__: { setMeasureMode(on: boolean): void; setMeasureKind(k: string): void; placeMeasurementPoint(p: { x: number; y: number; z: number; layer?: string }): void } }).__OLV_TEST_API__;
    api.setMeasureMode(true);
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: 2, y: 2, z: 1, layer: l });
    api.placeMeasurementPoint({ x: 6, y: 5, z: 1, layer: l });
    api.setMeasureMode(false);
  }, layer);
  const taken = () => page.evaluate(() => (window as unknown as { __OLV_TEST_API__: { getMeasurementCount(): number } }).__OLV_TEST_API__.getMeasurementCount());
  await distanceOn('survey-b.las');
  expect(await taken()).toBe(1);
  await openAnalysePanel(page);
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 30_000 });
  const openDialog = async () => {
    const group = await openContourLane(page);
    await group.getByRole('button', { name: 'Contour map sheet (PDF)' }).click();
    const dialog = page.locator('.olv-modal[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    return dialog;
  };
  let dialog = await openDialog();
  const boxes = dialog.locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(1)).toBeDisabled();
  await expect(boxes.nth(1)).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  // A's own distance is offered.
  await distanceOn('survey-a.las');
  expect(await taken()).toBe(2);
  dialog = await openDialog();
  await expect(boxes.nth(1)).toBeEnabled();
  await expect(boxes.nth(1)).toBeChecked();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Export PDF' }).click()]);
  expect(readFileSync((await download.path())!).subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

test('Export mode: a map sheet that cannot be written says why', async ({ page }) => {
  test.setTimeout(120_000);
  await analyseFixture(page);
  // A second scan becomes active; the analysis belongs to the first one.
  await dropTinyLas(page);
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  const group = await openContourLane(page);
  const btn = group.getByRole('button', { name: 'Contour map sheet (PDF)' });
  // The lane re-renders on the active-scan change, so the button is already
  // disabled and says why before any press.
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveAttribute('title', /different scan/i);
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
