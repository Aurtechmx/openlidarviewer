import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, showWorkspaceMode, suppressOnboardingTour } from './helpers';

/**
 * exportFailureStates.spec.ts
 *
 * Visible-state coverage for the "exports" lane audit findings.
 *
 *  - ANALYSIS-F3 / OUTPUT-F2: a Contour Studio export (DEM ZIP) that fails
 *    (a lazy chunk that cannot load — the same class of failure a stale
 *    deploy or a flaky connection produces) must flash a visible "Export
 *    failed" state on the button the user pressed, then restore it — instead
 *    of silently reverting with no signal anything went wrong.
 */

async function openAnalyse(page: Page): Promise<void> {
  await showWorkspaceMode(page, 'analyse');
  const panel = page.locator('.olv-analyse-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
}

test('a failed Contour Studio DEM export flashes "Export failed" on the pressed button, then restores it (ANALYSIS-F3 / OUTPUT-F2)', async ({
  page,
}) => {
  await suppressOnboardingTour(page);
  // Defensive: harmless in dev (no `vite:preloadError` wrapper fires there),
  // and stops the production stale-chunk-reload path from reloading the page
  // out from under this test if it is ever run against the built artifact —
  // mirrors tests/e2e/lazyChunkLoad.spec.ts.
  await page.addInitScript((key: string) => {
    try {
      sessionStorage.setItem(key, String(Date.now()));
    } catch {
      // Storage may be blocked; the test still exercises the failure path.
    }
  }, 'olv:stale-reload-at');

  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await openAnalyse(page);

  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, {
    timeout: 20_000,
  });

  const launch = page.locator('.olv-analyse-contour-launcher .olv-contour-launcher-action');
  await expect(launch).toBeVisible({ timeout: 20_000 });
  await launch.click();
  await expect(page.locator('.olv-analyse-contour-deliverable')).not.toHaveClass(/olv-hidden/);

  const dem = page.locator('.olv-cs-export-btn', { hasText: /^DEM \(ZIP\)$/ });
  await expect(dem).toBeVisible();
  await expect(dem).toBeEnabled();

  // Force the DEM package chunk to fail loading — a stale-deploy / flaky-
  // connection failure, not a data problem. Matches both the dev-server
  // (unhashed) and the built-artifact (hashed) module URL.
  await page.route('**/demPackage*', (route) => route.abort());

  await dem.click();
  // Silent revert (the pre-fix behaviour) would go straight back to "DEM
  // (ZIP)" with no visible trace; the fix flashes a distinct failed state on
  // the SAME button first.
  await expect(dem).toHaveText('Export failed', { timeout: 10_000 });
  await expect(dem).toBeDisabled();

  // …then restores it, so the control is usable again rather than stuck.
  await expect(dem).toHaveText('DEM (ZIP)', { timeout: 10_000 });
  await expect(dem).toBeEnabled();
});
