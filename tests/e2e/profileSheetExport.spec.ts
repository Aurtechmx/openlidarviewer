import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import AxeBuilder from '@axe-core/playwright';
import { pdfText } from './pdfText';
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

async function openProfileDialog(page: Page) {
  await page.locator('.olv-mp-profile-pdf', { hasText: 'Export PDF' }).first().click();
  const dialog = page.locator('.olv-pe .olv-modal[role="dialog"], .olv-pe [role="dialog"]').first();
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return dialog;
}

async function exportProfilePdf(page: Page): Promise<Buffer> {
  const dialog = await openProfileDialog(page);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    dialog.getByRole('button', { name: 'Export PDF' }).click(),
  ]);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
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

test('the dialog prints what the user adds, in the language chosen, and keeps it for the next export', async ({ page, browserName }) => {
  test.setTimeout(180_000);
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
  let dialog = await openProfileDialog(page);
  const logo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const closed = dialog.locator('details:not([open]) > summary');
  while ((await closed.count()) > 0) await closed.first().click();
  await dialog.getByLabel('Title', { exact: true }).fill('Río Bravo, sección 4');
  await dialog.getByLabel('Client').fill('Ayuntamiento');
  await dialog.getByLabel('Company', { exact: true }).fill('Topografía Norte');
  await dialog.getByLabel('Logo', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo });
  await expect(dialog.locator('.olv-pe-logo')).toBeVisible();
  // Not an image: refused with the reason, and the logo already chosen stays. An SVG is taken as a picture of itself.
  await dialog.getByLabel('Logo', { exact: true }).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await expect(dialog.getByRole('status')).toContainText('Choose a PNG');
  await expect(dialog.locator('.olv-pe-logo')).toBeVisible();
  await dialog.getByLabel('Logo', { exact: true }).setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20"><rect width="60" height="20" fill="#123456"/></svg>') });
  await expect.poll(() => dialog.locator('.olv-pe-logo').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(800);
  await dialog.getByLabel('Prepared by').fill('A. Pérez');
  await dialog.getByLabel('Drawing number').fill('PL-014');
  await dialog.getByLabel('Status').selectOption('review');
  await dialog.getByRole('button', { name: 'Add an issue' }).click();
  await dialog.getByLabel('Description, issue 1').fill('Para comentarios');
  await dialog.getByRole('button', { name: 'Add a marked point' }).click();
  await dialog.getByLabel('Chainage, marked point 1').fill('99');
  await dialog.getByLabel('Text, marked point 1').fill('Alcantarilla');
  await dialog.getByLabel('Notes', { exact: true }).fill('Nota del autor');
  await dialog.getByLabel('Language').selectOption('es');
  if (browserName !== 'firefox') {
    const axe = await new AxeBuilder({ page }).include('.olv-pe').analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([]);
  }
  // A point past the end is refused with the reason, and nothing is saved.
  await dialog.getByRole('button', { name: 'Export PDF' }).click();
  await expect(dialog.getByRole('alert')).toContainText('past the end of the line');
  await dialog.getByLabel('Chainage, marked point 1').fill('3,5');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Export PDF' }).click()]);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  const lines = await pdfText(readFileSync((await download.path())!));
  for (const want of ['Río Bravo, sección 4', 'Ayuntamiento', 'Topografía Norte', 'A. Pérez', 'PL-014', 'Para revisión', 'Para comentarios', 'Alcantarilla', 'Nota del autor', 'Notas técnicas', 'traducción pendiente de revisión', 'sin calidad topográfica']) expect(lines, want).toContain(want);
  expect(lines).not.toContain('Technical notes');
  // Kept for this profile and this session; nothing is kept on the device unasked.
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('deliverable')))).toEqual([]);
  dialog = await openProfileDialog(page);
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Río Bravo, sección 4');
  await expect(dialog.getByLabel('Company', { exact: true })).toHaveValue('Topografía Norte');
  await dialog.getByLabel('Remember company, logo and people on this device').check();
  await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Export PDF' }).click()]);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('olv.deliverable.company:v1') ?? '{}').company)).toBe('Topografía Norte');
  // Unticking it forgets.
  dialog = await openProfileDialog(page);
  await dialog.getByLabel('Remember company, logo and people on this device').uncheck();
  await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Export PDF' }).click()]);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  expect(await page.evaluate(() => localStorage.getItem('olv.deliverable.company:v1'))).toBeNull();
  // Escape closes without a file, and focus goes back to the button.
  dialog = await openProfileDialog(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.olv-mp-profile-pdf', { hasText: 'Export PDF' }).first()).toBeFocused();
  // What was typed and not exported is there again, says so, and Discard puts the saved details back.
  dialog = await openProfileDialog(page);
  await expect(dialog.getByText('Unexported details from last time.')).toHaveCount(0);
  await dialog.getByLabel('Title', { exact: true }).fill('Not exported');
  await page.keyboard.press('Escape');
  dialog = await openProfileDialog(page);
  await expect(dialog.getByText('Unexported details from last time.')).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Not exported');
  expect(await page.evaluate(() => Object.values(localStorage).some((v) => String(v).includes('Not exported')))).toBe(false);
  await dialog.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Río Bravo, sección 4');
  await expect(dialog.getByLabel('Title', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  // Text selected by dragging out of the dialog does not close it.
  dialog = await openProfileDialog(page);
  const box = (await dialog.getByLabel('Title', { exact: true }).boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(4, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Río Bravo, sección 4');
  // A press that starts outside closes it.
  await page.mouse.click(4, 300);
  await expect(dialog).toBeHidden();
  // A comma that reads two ways is asked about; the length as shown is on the line.
  dialog = await openProfileDialog(page);
  const marks = dialog.locator('details', { hasText: 'Marked points' }).locator('summary');
  if (!(await dialog.getByLabel('Chainage, marked point 1').isVisible())) await marks.first().click();
  await dialog.getByLabel('Chainage, marked point 1').fill('1,250');
  await dialog.getByRole('button', { name: 'Export PDF' }).click();
  await expect(dialog.getByRole('alert')).toContainText('could be read two ways');
  // Export waits while a logo is being read, and a removed logo does not come back.
  await page.evaluate(() => {
    const gate = new Promise<void>((r) => { (window as unknown as { __read: () => void }).__read = r; });
    Object.defineProperty(HTMLImageElement.prototype, 'onload', {
      configurable: true,
      set(this: HTMLImageElement, fn: () => void) { void gate.then(() => { if (this.complete) fn(); else this.addEventListener('load', fn); }); },
    });
  });
  await dialog.getByLabel('Logo', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo });
  await expect(dialog.getByRole('button', { name: 'Export PDF' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Remove logo' }).click();
  await expect(dialog.getByRole('button', { name: 'Export PDF' })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { __read: () => void }).__read());
  await page.waitForTimeout(300);
  await expect(dialog.locator('.olv-pe-logo')).toBeHidden();
});

/** A profile between two points, with the Measure tool open. */
async function placeLine(page: Page, dy: number): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await page.evaluate((y) => {
    const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind(k: string): void; placeMeasurementPoint(p: { x: number; y: number; z: number }): void; finishMeasurement?(): void } }).__OLV_TEST_API__;
    api.setMeasureKind('profile');
    api.placeMeasurementPoint({ x: -4, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 4, y, z: 0 });
    api.finishMeasurement?.();
  }, dy);
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
}

test('the length of the line as the dialog shows it can be marked', async ({ page }) => {
  test.setTimeout(120_000);
  await placeLine(page, 0.5);
  const dialog = await openProfileDialog(page);
  const closed = dialog.locator('details:not([open]) > summary');
  while ((await closed.count()) > 0) await closed.first().click();
  await dialog.getByRole('button', { name: 'Add a marked point' }).click();
  await dialog.getByLabel('Text, marked point 1').fill('End peg');
  await dialog.getByLabel('Chainage, marked point 1').fill('99');
  await dialog.getByRole('button', { name: 'Export PDF' }).click();
  const shown = /end of the line \(([\d.]+) /.exec((await dialog.getByRole('alert').textContent()) ?? '')![1]!;
  // The line is the square root of 64.25 long, which is shown rounded up.
  expect(Number(shown)).toBeGreaterThan(Math.sqrt(64.25));
  await dialog.getByLabel('Chainage, marked point 1').fill(shown);
  await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Export PDF' }).click()]);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
});

test('code that cannot be loaded is said so in the dialog, and nothing is saved', async ({ page }) => {
  test.setTimeout(120_000);
  await placeLine(page, 0);
  const dialog = await openProfileDialog(page);
  await page.route(/\/assets\/profilePdf-[^/]*\.js/, (r) => r.abort());
  let saved = 0;
  page.on('download', () => { saved++; });
  await dialog.getByRole('button', { name: 'Export PDF' }).click();
  await expect(dialog.getByRole('alert')).toContainText('PDF export could not load', { timeout: 30_000 });
  await expect(dialog.getByRole('button', { name: 'Export PDF' })).toBeEnabled();
  expect(saved).toBe(0);
});
