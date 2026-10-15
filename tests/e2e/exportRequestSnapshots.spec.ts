import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { geomFixtures, dropBytes } from './geomFixtures';
import { openToolPage, showWorkspaceMode } from './helpers';
import { tileAt } from './georefTile';

/**
 * An export describes one request: the scan, the clip and the frame as they
 * stood when the user pressed the button. These specs hold a lazy chunk the
 * export waits on, change the scene during the wait, and check that the file
 * that arrives is wholly the scan it was asked for, or that nothing arrives.
 *
 * The quick-format buttons (PLY, OBJ, XYZ, CSV) honour the active clip box
 * exactly as the conversion export does: the same points, at the same world
 * coordinates, with the clip disclosed.
 */

type Xyz = [number, number, number];

test.setTimeout(120_000);

(globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
  version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
};
const QUICK_FORMATS = ['XYZ', 'PLY', 'OBJ', 'CSV'] as const;

async function exportPanel(page: Page): Promise<Locator> {
  await showWorkspaceMode(page, 'output');
  const p = page.locator('.olv-export-panel');
  await expect(p).toBeVisible({ timeout: 20_000 });
  if (await p.evaluate((e) => e.classList.contains('olv-collapsed'))) await p.locator('.olv-panel-head').click();
  return p;
}

async function quickSection(exp: Locator): Promise<void> {
  const summary = exp.locator('summary', { hasText: /^Export$/ });
  const btn = exp.locator('.olv-export-btn', { hasText: /^XYZ$/ });
  if (!(await btn.isVisible())) await summary.click();
  await expect(btn).toBeVisible();
}

async function openClip(page: Page): Promise<Locator> {
  await openToolPage(page, 'Clip box');
  const clip = page.locator('.olv-clip-panel');
  await expect(clip).toBeVisible({ timeout: 20_000 });
  if (await clip.evaluate((e) => e.classList.contains('olv-collapsed'))) await clip.locator('.olv-panel-head').click();
  return clip;
}

async function enableClip(clip: Locator): Promise<void> {
  await clip.locator('label', { hasText: 'Clip the scan to this box' }).click();
  await clip.locator('summary', { hasText: 'Advanced' }).click();
}

async function setBound(clip: Locator, label: string, v: number): Promise<void> {
  const input = clip.getByLabel(label, { exact: true });
  await input.fill(String(v));
  await input.press('Enter');
}

async function clipCount(page: Page): Promise<{ kept: number; total: number }> {
  return page.evaluate(() => (window as unknown as { __OLV_TEST_API__: { getClipState(): { count: { kept: number; total: number } } } }).__OLV_TEST_API__.getClipState().count);
}

/** The point rows of an exported text file, as world coordinates, sorted. */
function pointsOf(text: string, format: string): Xyz[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let rows: string[];
  if (format === 'PLY') rows = lines.slice(lines.indexOf('end_header') + 1);
  else if (format === 'OBJ') rows = lines.filter((l) => l.startsWith('v ')).map((l) => l.slice(2));
  else if (format === 'CSV') rows = lines.filter((l) => !l.startsWith('#')).slice(1);
  else rows = lines.filter((l) => !l.startsWith('#'));
  return rows
    .map((l) => l.trim().split(/[\s,]+/).slice(0, 3).map(Number) as Xyz)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

const key = (p: Xyz): string => p.map((v) => v.toFixed(3)).join(',');

async function quickExport(page: Page, exp: Locator, format: string): Promise<{ name: string; text: string }> {
  await quickSection(exp);
  const w = page.waitForEvent('download');
  await exp.locator('.olv-export-btn', { hasText: new RegExp(`^${format}$`) }).click();
  const d = await w;
  return { name: d.suggestedFilename(), text: readFileSync((await d.path())!, 'utf8') };
}

async function conversionXyz(page: Page, exp: Locator): Promise<string> {
  await exp.locator('.olv-bc-pill', { hasText: /^XYZ$/ }).click();
  const w = page.waitForEvent('download');
  await exp.locator('.olv-bc-convert').click();
  const d = await w;
  return readFileSync((await d.path())!, 'utf8');
}

/** Hold every request for `glob` until `release()` is called. */
async function holdChunk(page: Page, glob: string): Promise<{ requested: Promise<void>; release: () => void }> {
  let reached!: () => void;
  const requested = new Promise<void>((r) => { reached = r; });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(glob, async (route) => { reached(); await held; await route.continue(); });
  return { requested, release };
}

/**
 * Hold `glob` from here on, once the scan's own load traffic has settled: the
 * source hash worker can start during a load, and holding it then would stall
 * the load rather than the export under test.
 */
async function holdAfterLoad(page: Page, glob: string): Promise<{ requested: Promise<void>; release: () => void }> {
  await page.waitForLoadState('networkidle');
  return holdChunk(page, glob);
}

async function lasB4326(): Promise<Uint8Array> {
  const { writeLas } = await import('../../src/convert/writeLas');
  return writeLas(
    { count: 4, x: Float64Array.from([10, 10.01, 10, 10.01]), y: Float64Array.from([20, 20, 20.01, 20.01]), z: Float64Array.from([1, 1, 1, 1]) },
    { epsg: 4326, isGeographic: true },
  );
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

test.describe('quick-format export honours the clip box', () => {
  test('every quick format writes the clipped points the conversion export writes, and says so', async ({ page }) => {
    const f = await geomFixtures();
    await page.goto('/?test=1');
    await dropBytes(page, f.geomA, 'clip-source.las');
    await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
    const clip = await openClip(page);
    await enableClip(clip);
    await setBound(clip, 'X max', 10);
    const count = await clipCount(page);
    expect(count.kept).toBeGreaterThan(0);
    expect(count.kept).toBeLessThan(count.total);

    const exp = await exportPanel(page);
    const reference = pointsOf(await conversionXyz(page, exp), 'XYZ');
    expect(reference).toHaveLength(count.kept);
    // Every reference point lies inside the box, in the scan's own frame.
    for (const p of reference) expect(p[0] - 500000).toBeLessThanOrEqual(10 + 1e-3);

    const kept = count.kept.toLocaleString('en-US');
    const total = count.total.toLocaleString('en-US');
    for (const format of QUICK_FORMATS) {
      const { name, text } = await quickExport(page, exp, format);
      const pts = pointsOf(text, format);
      expect(pts, `${format} point count`).toHaveLength(count.kept);
      expect(pts.map(key), `${format} point membership`).toEqual(reference.map(key));
      expect(name, `${format} file name`).toBe(`clip-source-clip.${format.toLowerCase()}`);
      if (format !== 'CSV') expect(text, `${format} scope line`).toContain(`Clipped: ${kept} of ${total} points`);
    }
  });

  test('a clip that keeps no points refuses the quick export and leaves the buttons usable', async ({ page }) => {
    const f = await geomFixtures();
    await page.goto('/?test=1');
    await dropBytes(page, f.geomA, 'empty-clip.las');
    await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
    const clip = await openClip(page);
    await enableClip(clip);
    await setBound(clip, 'X min', -50);
    await setBound(clip, 'X max', -40);
    expect((await clipCount(page)).kept).toBe(0);

    const exp = await exportPanel(page);
    await quickSection(exp);
    let downloads = 0;
    page.on('download', () => { downloads++; });
    const btn = exp.locator('.olv-export-btn', { hasText: /^XYZ$/ });
    await btn.click();
    await expect(page.locator('.olv-toast-error')).toContainText('keeps no points');
    await expect(btn).toBeEnabled({ timeout: 5_000 });
    await page.waitForTimeout(500);
    expect(downloads).toBe(0);
  });

  test('the clip captured at the click decides the file, not a clip changed while the writer loads', async ({ page }) => {
    const f = await geomFixtures();
    const hold = await holdChunk(page, '**/assets/exporters-*.js');
    await page.goto('/?test=1');
    await dropBytes(page, f.geomA, 'clip-race.las');
    await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
    const clip = await openClip(page);
    await enableClip(clip);
    await setBound(clip, 'X max', 10);
    const asked = await clipCount(page);

    const exp = await exportPanel(page);
    await quickSection(exp);
    const w = page.waitForEvent('download');
    await exp.locator('.olv-export-btn', { hasText: /^XYZ$/ }).click();
    await hold.requested;
    await openClip(page);
    await setBound(clip, 'X max', 20);
    const moved = await clipCount(page);
    expect(moved.kept).toBeGreaterThan(asked.kept);
    hold.release();
    const d = await w;
    const pts = pointsOf(readFileSync((await d.path())!, 'utf8'), 'XYZ');
    expect(pts).toHaveLength(asked.kept);
    for (const p of pts) expect(p[0] - 500000).toBeLessThanOrEqual(10 + 1e-3);
  });
});

test.describe('quick-format export over placed tiles', () => {
  const EPSG_UTM33N = 32633;
  const A = [500000, 4100000] as const;
  const B = [A[0] + 2000, A[1] + 2000] as const;

  async function tile(ox: number, oy: number): Promise<Uint8Array> {
    const { writeLas14 } = await import('../../src/convert/writeLas');
    const { wktForEpsg } = await import('../../src/io/epsgWkt');
    return writeLas14(tileAt(ox, oy), { wkt: wktForEpsg(EPSG_UTM33N)!, epsg: EPSG_UTM33N, linearUnitCode: 9001 });
  }

  async function offsetOf(page: Page, name: string): Promise<Xyz | null> {
    const rows = page.locator('.olv-layerhealth-layer', { hasText: name })
      .locator('.olv-layerhealth-row', { hasText: 'Offset to project' })
      .locator('.olv-layerhealth-row-value');
    if (await rows.count() === 0) return null;
    const nums = (await rows.first().textContent() ?? '').match(/-?\d+(?:\.\d+)?/g);
    return nums && nums.length >= 3 ? [Number(nums[0]), Number(nums[1]), Number(nums[2])] : null;
  }

  /** A box around the first two columns of tile B, in the project frame. */
  async function clipTileB(page: Page, off: Xyz): Promise<void> {
    const clip = await openClip(page);
    await enableClip(clip);
    await setBound(clip, 'X max', off[0] + 1.5);
    await setBound(clip, 'X min', off[0] - 0.5);
    await setBound(clip, 'Y max', off[1] + 3.5);
    await setBound(clip, 'Y min', off[1] - 0.5);
    await setBound(clip, 'Z max', off[2] + 50);
    await setBound(clip, 'Z min', off[2] - 50);
    await expect(clip.locator('[role="status"]')).toContainText(/^8 of 16 points kept/);
  }

  const expectedB = (): string[] => {
    const out: string[] = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 2; i++) out.push(`${B[0] + i},${B[1] + j}`);
    return out.sort();
  };

  test('a placed tile exports the clipped points at their real coordinates', async ({ page }) => {
    await page.goto('/?test=1');
    await dropBytes(page, await tile(A[0], A[1]), 'utm33-a.las');
    await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
    await dropBytes(page, await tile(B[0], B[1]), 'utm33-b.las');
    await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
    await expect(page.locator('.olv-layerhealth-layer')).toHaveCount(2, { timeout: 20_000 });
    const off = await offsetOf(page, 'utm33-b');
    expect(off).not.toBeNull();
    expect(Math.abs(off![0])).toBeGreaterThan(1);
    await clipTileB(page, off!);

    const exp = await exportPanel(page);
    for (const format of QUICK_FORMATS) {
      const { text } = await quickExport(page, exp, format);
      const xy = pointsOf(text, format).map((p) => `${p[0]},${p[1]}`).sort();
      expect(xy, format).toEqual(expectedB());
    }
  });

  test('the surviving tile exports the clipped points after the anchor tile is removed', async ({ page }) => {
    await page.goto('/?test=1');
    await dropBytes(page, await tile(A[0], A[1]), 'utm33-a.las');
    await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
    await dropBytes(page, await tile(B[0], B[1]), 'utm33-b.las');
    await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
    await showWorkspaceMode(page, 'data');
    await page.getByRole('button', { name: 'Remove utm33-a.las', exact: true }).click();
    await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
    const off = (await offsetOf(page, 'utm33-b')) ?? [0, 0, 0];
    await clipTileB(page, off);

    const exp = await exportPanel(page);
    const reference = pointsOf(await conversionXyz(page, exp), 'XYZ').map((p) => `${p[0]},${p[1]}`).sort();
    expect(reference).toEqual(expectedB());
    for (const format of QUICK_FORMATS) {
      const { text } = await quickExport(page, exp, format);
      const xy = pointsOf(text, format).map((p) => `${p[0]},${p[1]}`).sort();
      expect(xy, format).toEqual(expectedB());
    }
  });
});

test.describe('an export describes the scan it was asked for', () => {
  for (const [label, glob] of [
    ['the writer loads', '**/assets/exporters-*.js'],
    ['the source is hashed', '**/assets/localOocIndexerWorker-*.js'],
  ] as const) {
    test(`quick XYZ keeps scan A's identity when scan B opens while ${label}`, async ({ page }) => {
      const f = await geomFixtures();
      const b = await lasB4326();
      await page.goto('/?test=1');
      await dropBytes(page, f.geomA, 'source-a.las');
      await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
      const hold = await holdAfterLoad(page, glob);
      const exp = await exportPanel(page);
      await quickSection(exp);
      let downloaded: { name: string; text: string } | null = null;
      page.on('download', async (d) => { downloaded = { name: d.suggestedFilename(), text: readFileSync((await d.path())!, 'utf8') }; });
      await exp.locator('.olv-export-btn', { hasText: /^XYZ$/ }).click();
      await hold.requested;
      await dropBytes(page, b, 'source-b.las');
      await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
      hold.release();
      await expect.poll(() => downloaded, { timeout: 60_000 }).not.toBeNull();
      const { name, text } = downloaded!;
      expect(name).toBe('source-a.xyz');
      expect(text.includes(sha(b)), 'scan B digest in the file').toBe(false);
      expect(text.includes(sha(f.geomA)), 'scan A digest in the file').toBe(true);
      expect(/EPSG:4326/.test(text), 'scan B CRS in the file').toBe(false);
      const first = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
      expect(first).toMatch(/^500000\./);
    });
  }
});

/** The text a PDF draws: every Flate content stream inflated, then its string operands decoded. */
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
    for (const h of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) out.push(Buffer.from(h[1].replace(/\s+/g, ''), 'hex').toString('latin1'));
    for (const l of body.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(l[1]);
    re.lastIndex = end;
  }
  return out.join('\n');
}

test.describe('the technical PDF describes one scan', () => {
  for (const [label, glob] of [
    ['the source is hashed', '**/assets/localOocIndexerWorker-*.js'],
    ['the report engine loads', '**/assets/report-*.js'],
  ] as const) {
    test(`scan B opened while ${label} does not reach scan A's report`, async ({ page }) => {
      const f = await geomFixtures();
      const { writeLas } = await import('../../src/convert/writeLas');
      const b = writeLas(
        { count: 4, x: Float64Array.from([6000000, 6000010, 6000000, 6000010]), y: Float64Array.from([2000000, 2000000, 2000010, 2000010]), z: Float64Array.from([10, 10, 10, 10]) },
        { epsg: 2225, linearUnitCode: 9003, verticalUnitCode: 9003 },
      );
      await page.goto('/?test=1');
      await dropBytes(page, f.geomA, 'report-source-a.las');
      await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
      const hold = await holdAfterLoad(page, glob);
      const distance = async (points: number[][], openPage = true): Promise<void> => {
        if (openPage) await openToolPage(page, 'Measure');
        await page.evaluate((ps) => {
          const a = (window as unknown as { __OLV_TEST_API__: { setMeasureKind(k: string): void; placeMeasurementPoint(p: { x: number; y: number; z: number }): void } }).__OLV_TEST_API__;
          a.setMeasureKind('distance');
          for (const p of ps) a.placeMeasurementPoint({ x: p[0], y: p[1], z: p[2] });
        }, points);
      };
      // 5 m on scan A; 10 units on scan B.
      await distance([[4, 2, 1], [7, 6, 1]]);
      const exp = await exportPanel(page);
      await exp.locator('summary', { hasText: 'Report PDF' }).click();
      await exp.getByRole('combobox', { name: 'PDF report template' }).selectOption('technical-report');
      let downloaded: { name: string; bytes: Buffer } | null = null;
      page.on('download', async (d) => { downloaded = { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) }; });
      const button = exp.getByRole('button', { name: 'Report PDF', exact: true });
      await button.click();
      await hold.requested;
      await dropBytes(page, b, 'report-source-b.las');
      await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
      await distance([[0, 0, 0], [10, 0, 0]], false);
      expect(await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: { getMeasurementCount(): number } }).__OLV_TEST_API__.getMeasurementCount())).toBe(2);
      hold.release();
      // Either a whole report of scan A arrives, or the export refuses and
      // the button comes back.
      await expect.poll(async () => downloaded !== null || (await page.locator('.olv-toast-error').count()) > 0, { timeout: 60_000 }).toBe(true);
      if (downloaded === null) {
        await showWorkspaceMode(page, 'output');
        await expect(button).toBeEnabled({ timeout: 10_000 });
        return;
      }
      const { name, bytes } = downloaded as { name: string; bytes: Buffer };
      expect(name).toBe('report-source-a-technical-report.pdf');
      const text = pdfText(bytes);
      expect(text).toContain('report-source-a.las');
      expect(text).not.toContain('report-source-b.las');
      expect(text).not.toContain(sha(b).slice(0, 16));
      expect(text).not.toMatch(/2225/);
      expect(text).toContain(sha(f.geomA));
      // Scan A's 5 m distance is reported; scan B's 10 ft (3.048 m) is not,
      // and the capture fingerprint is scan A's (30,351 points, not B's 4).
      expect(text).toMatch(/\b5\.0+ m\b/);
      expect(text).not.toMatch(/3\.048/);
      expect(text).not.toMatch(/Point count: 4\b/);
    });
  }
});
