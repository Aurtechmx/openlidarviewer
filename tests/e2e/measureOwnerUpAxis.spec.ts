import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { geomFixtures, dropBytes } from './geomFixtures';
import { dropTinyPly, openToolPage, showWorkspaceMode } from './helpers';

/**
 * A measurement reads its height, grade, profile and box along the up axis of
 * the layer it was taken on. A Z-up survey (LAS) and a Y-up scan (PLY) can be
 * open together; adding, removing or hiding one must not turn the other's
 * 5 m height into 0, in the panel, the CSV or the technical PDF. Navigation
 * follows the active layer's up axis, and returns to the survivor's after a
 * removal.
 */

interface Seam {
  setMeasureKind(k: string): void;
  placeMeasurementPoint(p: { x: number; y: number; z: number; layer?: string }): void;
  getMeasurementCount(): number;
  sceneUp(): { world: number[]; camera: number[] };
  activeScan(): { activeName: string | null };
}

async function measure(page: Page, kind: string, points: number[][], layer?: string): Promise<void> {
  await openToolPage(page, 'Measure');
  await page.evaluate(({ kind, points, layer }) => {
    const a = (window as unknown as { __OLV_TEST_API__: Seam }).__OLV_TEST_API__;
    a.setMeasureKind(kind);
    for (const p of points) a.placeMeasurementPoint({ x: p[0], y: p[1], z: p[2], ...(layer ? { layer } : {}) });
  }, { kind, points, layer });
}

async function values(page: Page): Promise<string[]> {
  await openToolPage(page, 'Measure');
  return page.locator('.olv-mp-value').allTextContents();
}

async function csvColumn(page: Page, column: string): Promise<number[]> {
  await showWorkspaceMode(page, 'output');
  const p = page.locator('.olv-export-panel');
  if (await p.evaluate((e) => e.classList.contains('olv-collapsed'))) await p.locator('.olv-panel-head').click();
  const h = p.locator('.olv-export-products-head');
  if ((await h.getAttribute('aria-expanded')) === 'false') await h.click();
  const w = page.waitForEvent('download');
  await p.locator('.olv-export-product-actions button', { hasText: /^CSV$/ }).click();
  const text = readFileSync((await (await w).path())!, 'utf8');
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const i = head!.split(',').indexOf(column);
  return rows.map((r) => Number(r.split(',')[i]));
}

/** The text a PDF draws: every Flate stream inflated, its string operands decoded. */
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
      body = raw.slice(start, end);
    }
    for (const h of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) out.push(Buffer.from(h[1]!.replace(/\s+/g, ''), 'hex').toString('latin1'));
    for (const l of body.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(l[1]!);
    for (const t of body.matchAll(/\[((?:[^\]])*)\]\s*TJ/g)) {
      out.push([...t[1]!.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((s) => s[1]).join(''));
    }
    re.lastIndex = end + 'endstream'.length;
  }
  return out.join('\n');
}

async function technicalPdf(page: Page): Promise<string> {
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  if (await panel.evaluate((e) => e.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  await panel.locator('summary', { hasText: 'Report PDF' }).click();
  await panel.getByRole('combobox', { name: 'PDF report template' }).selectOption('technical-report');
  const w = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Report PDF', exact: true }).click();
  return pdfText(readFileSync((await (await w).path())!));
}

const sceneUp = (page: Page) => page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Seam }).__OLV_TEST_API__.sceneUp());
const activeName = (page: Page) => page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Seam }).__OLV_TEST_API__.activeScan().activeName);

async function remove(page: Page, name: string, left: number): Promise<void> {
  await showWorkspaceMode(page, 'data');
  await page.getByRole('button', { name: `Remove ${name}`, exact: true }).click();
  await expect(page.locator('.olv-layer')).toHaveCount(left, { timeout: 20_000 });
}

async function openLas(page: Page): Promise<void> {
  const f = await geomFixtures();
  await dropBytes(page, f.geomA, 'metre.las');
}

/** Wait until `count` layers are open and the load has finished: `name` is active and no progress bar shows. */
async function opened(page: Page, count: number, name: string): Promise<void> {
  await expect(page.locator('.olv-layer')).toHaveCount(count, { timeout: 30_000 });
  await expect.poll(() => activeName(page), { timeout: 30_000 }).toBe(name);
  await expect(page.getByRole('progressbar', { name: 'Loading progress' })).toHaveCount(0, { timeout: 30_000 });
}

const Z_UP = { world: [0, 0, 1], camera: [0, 0, 1] };
const Y_UP = { world: [0, 1, 0], camera: [0, 1, 0] };

test.describe('a measurement keeps the up axis of the layer it was taken on', () => {
  // Two scans, several exports and a PDF on a software renderer.
  test.describe.configure({ timeout: 120_000 });
  test('LAS then PLY: the height stays 5 m in the panel, CSV and PDF, through add and removal of the active PLY', async ({ page }) => {
    await page.goto('/?test=1');
    await openLas(page);
    await opened(page, 1, 'metre.las');
    await measure(page, 'height', [[4, 2, 1], [4, 2, 6]]);
    await expect(page.locator('.olv-mp-value')).toHaveText(/^5\.0000 m/);
    expect(await sceneUp(page)).toEqual(Z_UP);

    await dropTinyPly(page);
    await opened(page, 2, 'tiny.ply');
    // Navigation follows the active (Y-up) layer; the LAS height does not.
    expect(await sceneUp(page)).toEqual(Y_UP);
    await openToolPage(page, 'Measure');
    await expect(page.locator('.olv-mp-value')).toHaveText(/^5\.0000 m/);
    expect(await csvColumn(page, 'vertical_m')).toEqual([5]);

    await remove(page, 'tiny.ply', 1);
    await expect.poll(() => activeName(page)).toBe('metre.las');
    expect(await sceneUp(page)).toEqual(Z_UP);
    await openToolPage(page, 'Measure');
    await expect(page.locator('.olv-mp-value')).toHaveText(/^5\.0000 m/);
    expect(await csvColumn(page, 'vertical_m')).toEqual([5]);
    const pdf = await technicalPdf(page);
    expect(pdf).toMatch(/Height 1[\s\S]{0,40}5\.0000 m/);
    expect(pdf).not.toMatch(/0\.0 cm/);
  });

  test('PLY then LAS: each layer measures along its own up axis, and removing the inactive PLY keeps Z up', async ({ page }) => {
    await page.goto('/?test=1');
    await dropTinyPly(page);
    await opened(page, 1, 'tiny.ply');
    await openLas(page);
    await opened(page, 2, 'metre.las');
    expect(await sceneUp(page)).toEqual(Z_UP);
    await measure(page, 'height', [[4, 2, 1], [4, 2, 6]], 'metre.las');
    // One unit along the PLY's own up (Y), measured while the Z-up LAS is active.
    await measure(page, 'height', [[0, 0, 0], [0, 1, 0]], 'tiny.ply');
    const both = await values(page);
    expect(both[0]).toMatch(/^5\.0000 m/);
    // tiny.ply declares no CRS, so the figure is in source units.
    expect(both[1]).toMatch(/^1(\.0+)?\b/);

    await remove(page, 'tiny.ply', 1);
    expect(await activeName(page)).toBe('metre.las');
    expect(await sceneUp(page)).toEqual(Z_UP);
    await expect(page.locator('.olv-mp-value').first()).toHaveText(/^5\.0000 m/);
    expect(await csvColumn(page, 'vertical_m')).toEqual([5]);
  });

  test('hiding and showing the Y-up layer leaves the LAS slope, profile, box and height unchanged', async ({ page }) => {
    await page.goto('/?test=1');
    await openLas(page);
    await opened(page, 1, 'metre.las');
    await measure(page, 'height', [[4, 2, 1], [4, 2, 6]]);
    await measure(page, 'slope', [[4, 2, 1], [8, 2, 3]]);
    await measure(page, 'profile', [[2, 2, 0], [12, 2, 0]]);
    await measure(page, 'box', [[4, 2, 1], [7, 6, 3]]);
    const before = await values(page);
    expect(before).toHaveLength(4);
    expect(before[0]).toMatch(/^5\.0000 m/);

    await dropTinyPly(page);
    await opened(page, 2, 'tiny.ply');
    expect(await values(page)).toEqual(before);

    await showWorkspaceMode(page, 'data');
    const ply = page.locator('.olv-layer', { hasText: 'tiny.ply' }).locator('input[type="checkbox"]');
    await ply.uncheck();
    expect(await values(page)).toEqual(before);
    await showWorkspaceMode(page, 'data');
    await ply.check();
    expect(await values(page)).toEqual(before);

    await remove(page, 'tiny.ply', 1);
    expect(await values(page)).toEqual(before);
    expect(await sceneUp(page)).toEqual(Z_UP);
  });

  test('a height whose points sit on a Z-up and a Y-up layer is withheld with its reason', async ({ page }) => {
    await page.goto('/?test=1');
    await openLas(page);
    await opened(page, 1, 'metre.las');
    await dropTinyPly(page);
    await opened(page, 2, 'tiny.ply');
    await openToolPage(page, 'Measure');
    await page.evaluate(() => {
      const a = (window as unknown as { __OLV_TEST_API__: Seam }).__OLV_TEST_API__;
      a.setMeasureKind('height');
      a.placeMeasurementPoint({ x: 4, y: 2, z: 1, layer: 'metre.las' });
      a.placeMeasurementPoint({ x: 1, y: 0.5, z: 0.25, layer: 'tiny.ply' });
    });
    await expect(page.locator('.olv-mp-value')).toHaveText('not combined: the points sit on layers with different up axes');
  });
});
