import { test, expect, type Page } from '@playwright/test';
import {
  activate,
  dropTinyLas,
  dropTinyPly,
  expectHittable,
  railChromeSettled,
  showWorkspaceMode,
} from './helpers';

/**
 * Feature-candidate review surface (v0.6.8) — the context-sensitive launcher.
 *
 * The contract: the launcher appears ONLY for a scan that carries a
 * classification, and the review list is honest — every result is a DERIVED
 * candidate, never a detected building or surveyed conductor.
 *
 * `tiny.las` carries a classification including class 6 (building) and no class
 * 14 (wire), so it drives both the building-candidate path and the "no wire
 * points" path. `tiny.ply` carries no classification, so it drives the absence
 * assertion. The extraction maths itself is pinned in the Node tests.
 */
async function openAnalyse(page: Page): Promise<void> {
  await showWorkspaceMode(page, 'analyse');
  const panel = page.locator('.olv-analyse-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
}

test('offers feature candidates for a classified scan, framed as candidates', async ({ page }) => {
  await page.goto('/?test=1');
  await dropTinyLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await railChromeSettled(page);
  await openAnalyse(page);

  const launcher = page.locator('.olv-feature-launcher');
  await expect(launcher).toBeVisible({ timeout: 20_000 });
  // The launcher states the honest framing before anything is extracted.
  await expect(launcher).toContainText('derived candidate');

  await expect(page.locator('.olv-feature-review')).toBeHidden();
  const extract = launcher.locator('.olv-feature-launcher-action');
  await expectHittable(extract);
  await activate(extract);

  const review = page.locator('.olv-feature-review');
  await expect(review).toBeVisible();
  // Both sections render; the conductor path is the "no wire points" one.
  await expect(review).toContainText('Building footprints');
  await expect(review).toContainText('Conductor fit');
  await expect(review).toContainText('No wire-classified points');
});

test('offers no feature candidates for a scan with no classification', async ({ page }) => {
  await page.goto('/?test=1');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await railChromeSettled(page);
  await openAnalyse(page);

  // tiny.ply carries RGB only, no classification channel, so the launcher
  // never appears.
  expect(await page.locator('.olv-feature-launcher').count()).toBe(0);
});
