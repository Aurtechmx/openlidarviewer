import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropDenseGridPly } from './helpers';

/**
 * v0.5.2 — the "Verify integrity report" command-palette tool. Round-trips the
 * feature end to end: export a real report, verify it (intact), then tamper a
 * figure and verify again (modified). The digest math itself is covered by the
 * verifyReport unit tests; this proves the UI wiring — file pick → verify →
 * verdict card — works against a genuinely-exported manifest.
 */

/** Export an integrity report and return the downloaded file's path. */
async function exportReport(page: Page): Promise<string> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
  await page.evaluate(() => {
    const api = (
      window as unknown as {
        __OLV_TEST_API__: {
          setMeasureKind: (k: string) => void;
          placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
        };
      }
    ).__OLV_TEST_API__;
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 1, y: 0, z: 0 });
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });

  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
  await panel.locator('.olv-export-products-head').click();
  const reportBtn = panel.locator('[data-testid="export-integrity-report"]');
  await expect(reportBtn).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await reportBtn.click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('report download had no path');
  return path;
}

/** Open the palette and run the "Verify integrity report" action with `file`. */
async function verifyWith(page: Page, file: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill('verify integrity');
  await page.locator('.olv-palette-row').filter({ hasText: 'Verify integrity report' }).first().click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
}

test('an exported report verifies as intact', async ({ page }) => {
  const reportPath = await exportReport(page);
  await verifyWith(page, reportPath);
  await expect(page.locator('[data-testid="report-verify-valid"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="report-verify-valid"]')).toHaveText(/intact/i);
  await page.locator('[data-testid="report-verify-close"]').click();
  await expect(page.locator('[data-testid="report-verify"]')).toHaveCount(0);
});

test('a tampered report is reported as modified', async ({ page }) => {
  const reportPath = await exportReport(page);
  // Alter a finding value without recomputing the digest.
  const manifest = JSON.parse(readFileSync(reportPath, 'utf8'));
  manifest.findings[0].value = 999999;
  const tampered = join(tmpdir(), `olv-tampered-${Date.now()}.json`);
  writeFileSync(tampered, JSON.stringify(manifest));

  await verifyWith(page, tampered);
  await expect(page.locator('[data-testid="report-verify-invalid"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="report-verify-invalid"]')).toHaveText(/modified/i);
});
