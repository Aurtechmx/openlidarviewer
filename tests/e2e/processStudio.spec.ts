import { test, expect } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * Process Studio (v0.6.5) — a display-only readiness view over the pure
 * Phase-1/2 services. It is a post-scan tool: hidden in the empty state,
 * revealed in the left rail on scan load, and re-hidden when the scan closes.
 * These specs guard the shell wiring (mount + reveal + populate) and the
 * fail-closed contract that products the scan cannot support read as blocked
 * rather than falsely ready.
 *
 * Runs against the dev server (see playwright.config.ts); the scan-loading
 * spec needs a real WebGL/WebGPU context and won't run in a GPU-less sandbox.
 */

test('stays hidden in the empty state before any scan is loaded', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.olv-process-studio')).toBeHidden();
});

test('reveals in the left rail and populates from live scan facts on load', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  const panel = page.locator('.olv-process-studio');
  await expect(panel).toBeVisible({ timeout: 20_000 });

  // Title + adaptive stage chips for the loaded scan.
  await expect(panel.locator('.olv-ps-title')).toHaveText('Process Studio');
  expect(await panel.locator('.olv-ps-stage').count()).toBeGreaterThan(0);

  // One row per product, each carrying a readiness badge.
  await expect(panel.locator('.olv-ps-product').first()).toBeVisible();
  expect(await panel.locator('.olv-ps-product').count()).toBeGreaterThan(0);
  await expect(panel.locator('.olv-ps-product .olv-ps-badge').first()).toBeVisible();

  // Fail-closed: an unreferenced cloud (linear unit unconfirmed) never reads as
  // a ready georeferenced product — the DTM row is withheld (review or blocked),
  // never `ready`.
  const dtmRow = panel.locator('.olv-ps-product', { hasText: 'DTM' });
  await expect(dtmRow).not.toHaveClass(/olv-ps-ready/);
  await expect(dtmRow).toHaveClass(/olv-ps-(review|blocked)/);

  // v0.6.5 — the WHY is compact by default but reachable without hover. The
  // reason is collapsed in a native <details>; a click/keypress on the summary
  // reveals it as VISIBLE text (a keyboard user can read it), not a data-tip
  // attribute the measure-bar-scoped CSS never renders here.
  const dtmReason = dtmRow.locator('.olv-ps-reason');
  await expect(dtmReason).toBeHidden(); // compact by default, no wall of text
  await dtmRow.locator('summary').click(); // one disclosure
  await expect(dtmReason).toBeVisible();
  expect(((await dtmReason.textContent()) ?? '').trim().length).toBeGreaterThan(0);
  // Regression guard against the old hidden-attribute pattern.
  await expect(dtmRow).not.toHaveAttribute('data-tip', /.+/);

  // Independent QA checks render with their own statuses.
  expect(await panel.locator('.olv-ps-check').count()).toBeGreaterThan(0);
});
