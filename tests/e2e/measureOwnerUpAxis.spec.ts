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
  await panel.locator('summary', { hasText: 'PDF report' }).click();
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

/**
 * A survey PLY at UTM 13N coordinates: a 100 x 100 m grid at 100 m height and
 * a point 100 m above its south-west corner. The loader recentres about the
 * floored minimum (500000, 4000000, 100), so that corner is local (0, 0, 0),
 * the point above it (0, 0, 100) and the grid point 100 m north (0, 100, 0).
 */
function surveyPly(): Uint8Array {
  const rows: string[] = [];
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) rows.push(`${500000 + i * 5} ${4000000 + j * 5} 100`);
  rows.push('500000 4000000 200');
  const head = `ply\nformat ascii 1.0\nelement vertex ${rows.length}\nproperty double x\nproperty double y\nproperty double z\nend_header\n`;
  return new TextEncoder().encode(head + rows.join('\n') + '\n');
}

async function assignCrs(page: Page, epsg: string): Promise<void> {
  await showWorkspaceMode(page, 'data');
  const crs = page.locator('summary', { hasText: 'Coordinate system' }).first();
  if (!(await crs.evaluate((s) => (s.parentElement as HTMLDetailsElement).open))) await crs.click();
  await page.locator('.olv-crs-select').first().selectOption(epsg);
}

/** The Layer Health rows of the first layer, label to value. */
async function layerRows(page: Page): Promise<Record<string, string>> {
  return page.locator('.olv-layerhealth-layer').first().evaluate((el) => Object.fromEntries(
    [...el.querySelectorAll('.olv-layerhealth-row')].map((r) => [r.querySelector('.olv-layerhealth-row-name')?.textContent ?? '', r.querySelector('.olv-layerhealth-row-value')?.textContent ?? '']),
  ));
}

test.describe('a PLY under a projected CRS measures, exports and navigates along Z', () => {
  test.describe.configure({ timeout: 120_000 });
  test('assigning EPSG:32613 after measuring moves heights, the CSV, the PDF and navigation to Z, and clearing it moves them back', async ({ page }) => {
    await page.goto('/?test=1');
    await dropBytes(page, surveyPly(), 'survey.ply');
    await opened(page, 1, 'survey.ply');
    await measure(page, 'height', [[0, 0, 0], [0, 0, 100]]);
    await measure(page, 'height', [[0, 0, 0], [0, 100, 0]]);
    // No CRS: a PLY is read Y-up, the app's stated rule for the format.
    expect(await sceneUp(page)).toEqual(Y_UP);
    let v = await values(page);
    expect(v[0]).toMatch(/^0(\.0+)?\b/);
    expect(v[1]).toMatch(/^100(\.0+)?\b/);
    await expect.poll(async () => (await layerRows(page))['Up axis']).toMatch(/^Y up \(PLY with no coordinate system is read Y-up/);

    await assignCrs(page, '32613');
    await expect.poll(() => sceneUp(page)).toEqual(Z_UP);
    await expect.poll(async () => (await layerRows(page))['Up axis']).toBe('Z up (coordinate system: X, Y, Z read as easting, northing, height)');
    v = await values(page);
    expect(v[0]).toMatch(/^100\.00 m/);
    expect(v[1]).toMatch(/^0\.0 cm/);
    expect(await csvColumn(page, 'vertical_m')).toEqual([100, 0]);
    const pdf = await technicalPdf(page);
    expect(pdf).toMatch(/Height 1[\s\S]{0,40}100\.00 m/);

    await assignCrs(page, '__detected__');
    await expect.poll(() => sceneUp(page)).toEqual(Y_UP);
    v = await values(page);
    expect(v[0]).toMatch(/^0(\.0+)?\b/);
  });

  test('a session saved under EPSG:32613 records the resolved frame and reopens with Z heights', async ({ page }) => {
    await page.goto('/?test=1');
    await dropBytes(page, surveyPly(), 'survey.ply');
    await opened(page, 1, 'survey.ply');
    await assignCrs(page, '32613');
    await expect.poll(() => sceneUp(page)).toEqual(Z_UP);
    await measure(page, 'height', [[0, 0, 0], [0, 0, 100]]);
    await measure(page, 'height', [[0, 0, 0], [0, 100, 0]]);
    await openToolPage(page, 'Measure');
    const dl = page.waitForEvent('download');
    await page.locator('.olv-mp-action', { hasText: 'Save session' }).click();
    const file = await dl;
    const bytes = readFileSync((await file.path())!);
    const json = JSON.parse(bytes.toString('utf8')) as { upAxis: string; upFrame?: { axis: string; basis: string } };
    // The format axis stays for matching; the resolved frame is recorded beside it.
    expect(json.upAxis).toBe('y');
    expect(json.upFrame).toEqual({ axis: 'z', basis: 'crs' });

    await page.reload();
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 30_000 });
    await dropBytes(page, surveyPly(), 'survey.ply');
    await opened(page, 1, 'survey.ply');
    await dropBytes(page, new Uint8Array(bytes), file.suggestedFilename());
    await expect.poll(async () => (await values(page)).length, { timeout: 20_000 }).toBe(2);
    const v = await values(page);
    expect(v[0]).toMatch(/^100\.00 m/);
    expect(v[1]).toMatch(/^0\.0 cm/);
    expect(await csvColumn(page, 'vertical_m')).toEqual([100, 0]);
  });

  test('on a phone the layer details still state the up axis and its basis', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?test=1');
    await dropBytes(page, surveyPly(), 'survey.ply');
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
    await expect.poll(async () => (await layerRows(page).catch(() => ({} as Record<string, string>)))['Up axis'], { timeout: 30_000 }).toMatch(/^Y up \(PLY with no coordinate system/);
    // Reachable with a tap: the Data page's Layer Health entry opens the card.
    await showWorkspaceMode(page, 'data');
    await page.getByRole('button', { name: /^Layer Health/ }).click();
    await page.getByRole('tab', { name: 'View' }).click();
    const row = page.locator('.olv-layerhealth-row', { hasText: 'Up axis' }).first();
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Y up (PLY with no coordinate system is read Y-up');
  });
});

/** The cells of one CSV column, as written (an empty cell stays an empty string). */
async function csvCells(page: Page, column: string): Promise<string[]> {
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
  expect(i).toBeGreaterThanOrEqual(0);
  return rows.map((r) => r.split(',')[i] ?? '');
}

/** Four UTM 13N points 100 vertical units apart, with the vertical unit given by `kind`. */
async function verticalUnitLas(kind: 'angular' | 'centimetre'): Promise<Uint8Array> {
  await geomFixtures();
  const { writeLas, writeLas14 } = await import('../../src/convert/writeLas');
  const { wktForEpsg } = await import('../../src/io/epsgWkt');
  const g = {
    count: 4,
    x: Float64Array.from([500000, 500001, 500000, 500001]),
    y: Float64Array.from([4000000, 4000000, 4000001, 4000001]),
    z: Float64Array.from([100, 100, 200, 200]),
  };
  if (kind === 'angular') {
    // NAVD88 beside an angular VerticalUnitsGeoKey: a vertical unit that cannot be read.
    return writeLas(g, { epsg: 32613, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9102 });
  }
  return writeLas14(g, {
    wkt: `COMPD_CS["UTM and local height",${wktForEpsg(32613)},VERT_CS["Local height",VERT_DATUM["Local datum",2005],UNIT["centimetre",0.01],AXIS["Up",UP]]]`,
  });
}

test.describe('a scan whose vertical unit is declared', () => {
  test.describe.configure({ timeout: 90_000 });

  test('an unreadable unit withholds the height in the panel and leaves vertical_m empty in the CSV', async ({ page }) => {
    await page.goto('/?test=1');
    await dropBytes(page, await verticalUnitLas('angular'), 'angular-z.las');
    await opened(page, 1, 'angular-z.las');
    await measure(page, 'height', [[0, 0, 0], [0, 0, 100]]);
    await expect(page.locator('.olv-mp-value')).toContainText('height unit could not be interpreted');
    await expect(page.locator('.olv-mp-value')).not.toContainText('100');
    expect(await csvCells(page, 'vertical_m')).toEqual(['']);
  });

  test('a centimetre unit is read by its factor: a 100-unit rise is 1 m, not 100 m', async ({ page }) => {
    await page.goto('/?test=1');
    await dropBytes(page, await verticalUnitLas('centimetre'), 'cm-z.las');
    await opened(page, 1, 'cm-z.las');
    await measure(page, 'height', [[0, 0, 0], [0, 0, 100]]);
    await expect(page.locator('.olv-mp-value')).toHaveText(/^1\.0000 m/);
    await expect(page.locator('.olv-mp-value')).not.toContainText('could not be interpreted');
    expect(await csvCells(page, 'vertical_m')).toEqual(['1']);
  });
});

test.describe('the elevation filter follows a layer whose up axis moves', () => {
  test.describe.configure({ timeout: 90_000 });

  test('assigning a CRS to a PLY clears a height window set along the old axis and says so', async ({ page }) => {
    await page.goto('/?test=1');
    await dropBytes(page, surveyPly(), 'survey.ply');
    await opened(page, 1, 'survey.ply');
    // The elevation filter is an Advanced inspector section.
    await page.locator('.olv-inspector .olv-detail-mode').getByRole('button', { name: 'Advanced' }).click();
    const min = page.getByLabel('Minimum elevation');
    const max = page.getByLabel('Maximum elevation');
    // A PLY with no CRS is read Y-up: the window is a range of northings.
    await expect(min).toHaveValue('4000000');
    await expect(max).toHaveValue('4000100');
    await min.fill('4000040');
    await expect(page.locator('.olv-filter-active')).toHaveCount(1);

    await assignCrs(page, '32613');
    await expect.poll(() => sceneUp(page)).toEqual(Z_UP);
    // The window is gone, the control is re-seeded along Z, and the user is told.
    await expect(page.getByText("Elevation filter cleared: a layer's up axis changed with its coordinate system")).toBeVisible();
    await expect(page.locator('.olv-filter-active')).toHaveCount(0);
    await expect(min).toHaveValue('100');
    await expect(max).toHaveValue('200');
  });
});
