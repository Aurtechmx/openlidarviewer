import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
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
  const lane = await sheetFacts(bytes);
  const viaStudio = await sheetFacts(studioBytes);
  expect(lane.pages).toBe(viaStudio.pages);
  expect(lane.evidence.length).toBeGreaterThan(0);
  expect(lane.evidence).toEqual(viaStudio.evidence);
  expect(lane.deliverable).toContain('Deliverable - Custom');
  expect(lane.deliverable).toEqual(viaStudio.deliverable);
  expect(Math.abs(studioBytes.length - bytes.length)).toBeLessThan(bytes.length * 0.005);
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
