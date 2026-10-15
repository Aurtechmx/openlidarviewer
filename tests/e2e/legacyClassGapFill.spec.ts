import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { showWorkspaceMode } from './helpers';
import { buildLas, readLas, type RawPoint } from '../helpers/rawLas';

/**
 * A legacy LAS carries class 8 (Model Key-point) and 12 (Overlap Points) plus
 * unclassified 0 and 1. "Fill unclassified" keeps the producer classes and
 * marks the buffer derived; the LAS 1.4 export must still write the kept 8
 * and 12 the way a plain 1.2 to 1.4 conversion does: class 1 with the
 * key-point or overlap flag. The written file is read with the independent
 * reader in tests/helpers/rawLas.ts.
 */

const KEY_POINT = 2;
const OVERLAP = 8;
const N = 100;

async function dropLasBytes(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ b, n }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(b)], n));
      return dt;
    },
    { b: [...bytes], n: name },
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

async function runPaletteAction(page: Page, query: string, row: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill(query);
  await expect(page.locator('.olv-palette-row', { hasText: row })).toBeVisible();
  await page.locator('.olv-palette-input').press('Enter');
  await expect(page.locator('.olv-palette')).toBeHidden();
}

test('Fill unclassified keeps legacy key-point and overlap meaning in a LAS 1.4 export', async ({ page }) => {
  const points: RawPoint[] = Array.from({ length: N }, (_, i) => ({ cls: i === 0 ? 8 : i === 1 ? 12 : i === 2 ? 2 : i % 2 }));
  const source = buildLas({ version: '1.2', pdrf: 3, points });

  await page.goto('/?test=1');
  await dropLasBytes(page, source, 'legacy-key-overlap.las');
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  await runPaletteAction(page, 'Fill unclassified', 'Fill unclassified points');
  await expect(page.getByText(/Fill unclassified · filled/)).toBeVisible({ timeout: 30_000 });

  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
  await expect(panel.getByRole('checkbox', { name: 'Include classification' })).toBeVisible({ timeout: 20_000 });
  await panel.locator('.olv-bc-pill', { hasText: 'LAS 1.4' }).click();

  const downloadPromise = page.waitForEvent('download');
  await panel.locator('.olv-bc-convert').click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('download produced no local path');

  const out = readLas(new Uint8Array(readFileSync(path)));
  expect(out.count).toBe(N);
  expect(out.cls.slice(0, 3)).toEqual([1, 1, 2]);
  expect(out.flags.slice(0, 3)).toEqual([KEY_POINT, OVERLAP, 0]);
  // The filled points carry derived classes, written as they are.
  expect(out.cls.slice(3).every((c) => c >= 1 && c <= 6)).toBe(true);
});
