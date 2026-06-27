import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dropDenseGridPly } from './helpers';

/**
 * Products lane → "Signed report" — places a measurement via the test seam,
 * exports the signed JSON report, and asserts the download is a real, signed
 * manifest (signature + findings + provenance). The signature's cryptographic
 * correctness is covered by the reportManifest unit tests; this proves the UI
 * wiring assembles and downloads a genuine manifest end-to-end.
 */
test('the Products lane exports a signed report after a measurement is placed', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  // Arm the Measure tool (placement only registers while measure mode is on),
  // then place a distance — it auto-completes at the second point.
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
  // Open the Products lane and confirm the signed-report action is enabled.
  await panel.locator('.olv-export-products-head').click();
  const reportBtn = panel.locator('[data-testid="export-signed-report"]');
  await expect(reportBtn).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await reportBtn.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-report\.json$/);

  const path = await download.path();
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  expect(manifest.signature).toBeTruthy();
  expect(Array.isArray(manifest.findings)).toBe(true);
  expect(manifest.findings.length).toBeGreaterThanOrEqual(1);
  // Provenance the report carries forward.
  expect(typeof manifest.classificationEpoch).toBe('number');
  expect(manifest.version).toBe(1);
});
