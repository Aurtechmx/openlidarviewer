import { test, expect } from '@playwright/test';
import { dropDenseGridPly, showWorkspaceMode } from './helpers';

/**
 * exportFailureStates.spec.ts
 *
 * Visible-state coverage for the "exports" lane audit findings.
 *
 *  - OUTPUT-F5: a point-cloud format button must disable itself for the
 *    duration of its own click, so a rapid double-click cannot fire a second,
 *    concurrent export — and the button releases again afterwards.
 *
 * ANALYSIS-F3 / OUTPUT-F2 (Contour Studio DEM export flashing "Export
 * failed" on a chunk-load failure, then restoring) is covered instead by
 * four unit tests in tests/contourExportAdapter.test.ts, one per export
 * product, driving ContourExportAdapter._busy against a host whose method
 * rejects. An e2e version of this scenario was tried here with both
 * page.route(...).abort() and route.fulfill() on the demPackage chunk;
 * both left the click "succeeding" in Chromium, Firefox and WebKit alike,
 * while the identical failure forced directly against the running app (the
 * chunk file replaced on disk, no Playwright routing involved) reliably
 * flashed "Export failed" and restored the button exactly as designed —
 * pointing at a route-interception gap specific to this nested dynamic
 * import chain rather than a product defect. Left for a future pass rather
 * than shipped as a red or flaky spec.
 */

test('a point-cloud format button disables itself for its own export and releases afterwards (OUTPUT-F5)', async ({
  page,
}) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await showWorkspaceMode(page, 'output');

  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
  // buildExportDeliverables' own "Export" section is a separate <details>
  // disclosure nested inside the panel body (closed by default), distinct
  // from the panel's own expand/collapse and from the converter's "Export"
  // button above it.
  const exportDisclosure = panel.locator('summary.olv-section-summary', { hasText: /^Export$/ });
  await exportDisclosure.click();

  const xyz = panel.locator('.olv-export-btn', { hasText: /^XYZ$/ });
  await expect(xyz).toBeVisible();
  await expect(xyz).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await xyz.click();
  // Guards the literal rapid-double-click: disabled for its own run rather
  // than staying clickable throughout, as it did before the fix.
  await expect(xyz).toBeDisabled();

  // The export itself still completes normally (the guard does not break the
  // happy path) and the button releases once it settles.
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.xyz$/);
  await expect(xyz).toBeEnabled({ timeout: 5_000 });
});
