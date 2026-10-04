import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { isBenignPageError } from './pageErrors';
import { openToolPage, showWorkspaceMode } from './helpers';
import { tileAt } from './georefTile';

/**
 * A clip box is in the project frame. With two georeferenced tiles mounted
 * 2 km apart, the second tile carries a non-zero offset into that frame. A
 * clip around part of that tile must export exactly the points the Clip page
 * counts as kept, at their real eastings.
 */

const EPSG_UTM33N = 32633;
const SEP_M = 2000;
const A = [500000, 4100000] as const;
const B = [A[0] + SEP_M, A[1] + SEP_M] as const;


async function lasAt(ox: number, oy: number): Promise<number[]> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
  };
  const { writeLas14 } = await import('../../src/convert/writeLas');
  const { wktForEpsg } = await import('../../src/io/epsgWkt');
  const wkt = wktForEpsg(EPSG_UTM33N)!;
  return [...writeLas14(tileAt(ox, oy), { wkt, epsg: EPSG_UTM33N, linearUnitCode: 9001 })];
}

async function dropBytes(page: Page, bytes: number[], name: string): Promise<void> {
  const dt = await page.evaluateHandle(({ b, n }) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(b)], n));
    return d;
  }, { b: bytes, n: name });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

function parseCoords(text: string): [number, number, number] | null {
  const nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 3) return null;
  return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
}

test('a clip over a placed tile exports the points it shows', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(String(e)); });

  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await dropBytes(page, await lasAt(A[0], A[1]), 'utm33-a.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await dropBytes(page, await lasAt(B[0], B[1]), 'utm33-b.las');
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator('.olv-layerhealth-layer')).toHaveCount(2, { timeout: 20_000 });

  // The second tile's offset into the project frame, as Layer Health states it.
  const offsetB = await page.locator('.olv-layerhealth-layer', { hasText: 'utm33-b' })
    .locator('.olv-layerhealth-row', { hasText: 'Offset to project' })
    .locator('.olv-layerhealth-row-value').textContent();
  const off = parseCoords(offsetB ?? '');
  expect(off, `tile B offset was "${offsetB}"`).not.toBeNull();
  expect(Math.abs(off![0]), 'tile B sits away from the frame origin').toBeGreaterThan(1);

  // A box in the project frame around tile B's first two columns (8 points).
  await openToolPage(page, 'Clip box');
  const panel = page.locator('.olv-clip-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  await panel.locator('label', { hasText: 'Clip the scan to this box' }).click();
  const set = async (label: string, v: number): Promise<void> => {
    const input = panel.getByLabel(label, { exact: true });
    await input.fill(String(v));
    await input.press('Enter');
  };
  await set('X max', off![0] + 1.5);
  await set('X min', off![0] - 0.5);
  await set('Y max', off![1] + 3.5);
  await set('Y min', off![1] - 0.5);
  await set('Z max', off![2] + 50);
  await set('Z min', off![2] - 50);
  const kept = panel.locator('[role="status"]');
  await expect(kept).toContainText(/^8 of 16 points kept/);

  await showWorkspaceMode(page, 'output');
  const exp = page.locator('.olv-export-panel');
  await expect(exp).toBeVisible({ timeout: 20_000 });
  if (await exp.evaluate((el) => el.classList.contains('olv-collapsed'))) await exp.locator('.olv-panel-head').click();
  await exp.locator('.olv-bc-pill', { hasText: 'XYZ' }).click();
  const downloadPromise = page.waitForEvent('download');
  await exp.locator('.olv-bc-convert').click();
  const path = await (await downloadPromise).path();
  const rows = readFileSync(path!, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.trim().split(/[\s,]+/).map(Number));
  const xy = rows.map((r) => `${r[0]},${r[1]}`).sort();
  const expected: string[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 2; i++) expected.push(`${B[0] + i},${B[1] + j}`);
  expect(xy).toEqual(expected.sort());
  expect(errors).toEqual([]);
});
