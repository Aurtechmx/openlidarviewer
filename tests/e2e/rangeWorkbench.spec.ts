import { test, expect, type Page } from '@playwright/test';
import {
  activate,
  dropDenseGridPly,
  dropTinyPtx,
  expectHittable,
  railChromeSettled,
  showWorkspaceMode,
} from './helpers';

/**
 * Range Frame Workbench launcher (v0.6.6) — the context-sensitive entry point.
 *
 * The contract this guards is a narrow one and it is the one that matters: the
 * launcher exists ONLY for a layer that actually carries an acquisition grid.
 * A permanent panel would have to explain itself to every user who opened a LAS
 * file, and a disabled one would advertise a surface that has nothing to show.
 *
 * PTX carries a grid; the synthesised PLY does not. Everything else about the
 * workbench — the raster, the diagnostics, the identity link — is pinned in the
 * Node tests, where the mapping and the refusals are actually decidable.
 */
async function openAnalyse(page: Page): Promise<void> {
  await showWorkspaceMode(page, 'analyse');
  const panel = page.locator('.olv-analyse-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
}

test('offers the workbench for a scan that carries an acquisition grid', async ({ page }) => {
  await page.goto('/?test=1');
  await dropTinyPtx(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await railChromeSettled(page);
  await openAnalyse(page);

  const launcher = page.locator('.olv-range-launcher');
  await expect(launcher).toBeVisible({ timeout: 20_000 });
  // The concise organization fact, on the grid the fixture declares.
  await expect(launcher.locator('.olv-range-launcher-fact')).toHaveText(
    'Organization: Structured, 6 × 4',
  );

  // The workbench itself is behind the launcher, not beside it.
  await expect(page.locator('.olv-range-workbench')).toBeHidden();
  const open = launcher.locator('.olv-range-launcher-action');
  await expectHittable(open);
  await activate(open);

  const workbench = page.locator('.olv-range-workbench');
  await expect(workbench).toBeVisible();
  await expect(workbench.locator('.olv-range-canvas')).toBeVisible();
  // Validity leads, and the linkage state is stated rather than assumed.
  await expect(workbench.locator('.olv-range-linkage')).toContainText('Exact linkage');
});

test('offers nothing for a scan that carries no acquisition grid', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await railChromeSettled(page);
  await openAnalyse(page);

  // Not hidden, not disabled: absent. A PLY has no grid, so there is nothing to
  // launch and no explanation owed.
  expect(await page.locator('.olv-range-launcher').count()).toBe(0);
  expect(await page.locator('.olv-range-workbench .olv-range-canvas').count()).toBe(0);
});
