import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * Analyse panel (v0.4.0) — the conservative surface for terrain readiness
 * and contour export. It is a post-scan tool: hidden until a scan loads,
 * revealed (collapsed) on load, and re-hidden when the scan is closed.
 * These specs guard the honesty contract from the hardening spec:
 *   - it stays hidden in the empty state (no clutter before a scan);
 *   - after a scan + run it surfaces readiness, recommended grid/interval,
 *     coverage, and status chips;
 *   - a minimal "Planned" tag row sets expectations (quiet tags, no dead
 *     buttons);
 *   - export is disabled when the DTM quality gate blocks it.
 *
 * Runs against the dev server (see playwright.config.ts); the scan-loading
 * specs need a real WebGL/WebGPU context and won't run in a GPU-less sandbox.
 */

async function openAnalyse(page: Page): Promise<void> {
  // The panel is revealed (collapsed) once a scan loads; expand it via its head.
  const panel = page.locator('.olv-analyse-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
}

test('stays hidden in the empty state before any scan is loaded', async ({ page }) => {
  await page.goto('/');
  // The empty state is shown…
  await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });
  // …and the Analyse panel is a post-scan tool, so it is not shown yet.
  await expect(page.locator('.olv-analyse-panel')).toBeHidden();
});

test('shows a minimal "Planned" tag row, with no dead buttons', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openAnalyse(page);
  // Quiet planned-capability tags; no verbose itemised cards.
  await expect(page.locator('.olv-analyse-plan-tag').first()).toBeVisible();
  expect(await page.locator('.olv-analyse-plan-tag').count()).toBeGreaterThan(0);
  expect(await page.locator('.olv-analyse-road-card').count()).toBe(0);
  // The planned area has no buttons or links — no clickable dead ends.
  expect(await page.locator('.olv-analyse-roadmap button, .olv-analyse-roadmap a').count()).toBe(0);
});

test('after running on a scan: readiness, chips, recommendations, and gated export appear', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await openAnalyse(page);

  await page.locator('.olv-analyse-run').click();
  // Readiness cards render (3 of them).
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, {
    timeout: 20_000,
  });
  // Honesty status chips are always shown.
  await expect(page.locator('.olv-analyse-chip', { hasText: 'Coverage' })).toBeVisible();
  await expect(page.locator('.olv-analyse-chip', { hasText: 'CRS' })).toBeVisible();
  await expect(page.locator('.olv-analyse-chip', { hasText: 'Export' })).toBeVisible();
  // Recommended grid + interval lines.
  await expect(page.locator('.olv-analyse-reco', { hasText: /Recommended grid/i })).toBeVisible();
  await expect(page.locator('.olv-analyse-reco', { hasText: /contour interval/i })).toBeVisible();

  // Export gating: a synthetic dense grid has coverage but no CRS, so the
  // DTM gate lands on `previewOnly` (not survey-grade). By design that still
  // offers a clearly-labelled preview export rather than disabling it — the
  // button stays enabled and the note flags it as not survey-grade. (A
  // `blocked` gate is what disables the buttons; that path is unit-tested.)
  const geojson = page.locator('.olv-analyse-dl', { hasText: 'GEOJSON' });
  await expect(geojson).toBeVisible();
  await expect(geojson).toBeEnabled();
  await expect(page.locator('.olv-analyse-export-note')).toContainText(/not survey-grade/i);
});
