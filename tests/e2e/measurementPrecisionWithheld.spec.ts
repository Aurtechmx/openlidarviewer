import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { isBenignPageError } from './pageErrors';
import { showWorkspaceMode, waitForLoadIdle } from './helpers';
import { dropBytes } from './geomFixtures';

/**
 * A measurement smaller than the step a very wide scan holds positions at is
 * withheld with the reason, in the Measure panel and in the CSV, rather than
 * shown as 0. The same 5 mm measured 1 km from the origin is reported.
 *
 * The scan is a UTM 13N LAS with its first point at E 500000; the measured
 * pair sits `reach` metres east of it, so the layer holds them at that
 * distance from its local origin.
 */

type Vec3 = [number, number, number];

async function lasBytes(reach: number): Promise<Uint8Array> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
  };
  const { writeLas } = await import('../../src/convert/writeLas');
  return writeLas(
    {
      count: 3,
      x: Float64Array.from([500000, 500000 + reach, 500000 + reach + 0.005]),
      y: Float64Array.from([4000000, 4000000, 4000000]),
      z: Float64Array.from([100, 100, 100]),
    },
    { epsg: 32613 },
  );
}

async function measure(page: Page, pts: Vec3[]): Promise<void> {
  if (!(await page.locator('.olv-measure-bar').isVisible())) await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
  await page.evaluate((p) => {
    const api = (window as unknown as {
      __OLV_TEST_API__: { setMeasureKind(k: string): void; placeMeasurementPoint(q: { x: number; y: number; z: number }): void };
    }).__OLV_TEST_API__;
    api.setMeasureKind('distance');
    for (const q of p) api.placeMeasurementPoint({ x: q[0], y: q[1], z: q[2] });
  }, pts);
}

async function exportCsv(page: Page): Promise<string> {
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  const head = panel.locator('.olv-export-products-head');
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  const wait = page.waitForEvent('download');
  await panel.locator('.olv-export-product-actions button', { hasText: /^CSV$/ }).click();
  return readFileSync((await (await wait).path())!, 'utf8');
}

/** The `length_m` cell of the first data row. */
function lengthCell(csv: string): string {
  const lines = csv.split('\n').filter((l) => l && !l.startsWith('#'));
  const head = lines[0].split(',');
  return lines[1].split(',')[head.indexOf('length_m')];
}

for (const reach of [1000, 200_000]) {
  test(`a 5 mm distance ${reach / 1000} km from the origin is ${reach > 1000 ? 'withheld with the reason' : 'reported'}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(String(e)); });
    page.on('console', (m) => { if (m.type() === 'error' && !isBenignPageError(m.text())) errors.push(m.text()); });
    await page.goto('/?test=1');
    await dropBytes(page, await lasBytes(reach), 'wide.las');
    await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
    await waitForLoadIdle(page);
    // Local coordinates: metres from the layer's floor(min) origin.
    await measure(page, [[reach, 0, 0], [reach + 0.005, 0, 0]]);
    const row = page.locator('.olv-measure-panel, .olv-measure-list').getByText(reach > 1000 ? /not resolved: this scan holds positions/ : /0\.5\d* cm|5(\.0+)? mm/).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const csv = await exportCsv(page);
    if (reach > 1000) {
      expect(lengthCell(csv)).toBe('');
      expect(csv).toMatch(/not resolved: positions on this scan are held about 15\.63 mm apart/);
    } else {
      expect(Number(lengthCell(csv))).toBeCloseTo(0.005, 3);
      expect(csv).not.toMatch(/not resolved/);
    }
    expect(errors).toEqual([]);
  });
}
