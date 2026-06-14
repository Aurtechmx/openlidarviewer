import { test, expect, type Page, type Locator } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * v0.4.6 standard axis-aligned views (Top / Bottom / Front / Back / Left /
 * Right) and the near-orthographic ("parallel") projection toggle.
 *
 * The view geometry is covered by cameraPresets.test.ts (standardViewPose +
 * STANDARD_VIEW_ORDER unit tests). This spec pins the DOM + handler wiring: the
 * NavBar HUD mounts a "Views" row of six chips plus an Ortho toggle, each fires
 * its handler without a console error, and the shared toast confirms the route
 * (`View · <Name>.`, `Orthographic (parallel) view on.` / `Perspective view
 * restored.`). Like the camera-presets spec, it does NOT assert the camera
 * actually reached the pose — headless WebGL pose tracking is flaky and the
 * geometry contract is already pinned by the unit tests.
 *
 * The "Views" and the angled "Camera" presets both render as `.olv-cam-chip`
 * inside a `.olv-cam-presets` row, and both contain a "Top" chip — so every
 * locator below is scoped to the row whose label is "Views".
 */

async function loadSample(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

/** The six standard views in their display order. */
const VIEW_NAMES = ['Top', 'Bottom', 'Front', 'Back', 'Left', 'Right'] as const;

/** The `.olv-cam-presets` row whose label reads "Views" (not "Camera"). */
function viewsRow(page: Page): Locator {
  return page
    .locator('.olv-cam-presets-row')
    .filter({ has: page.locator('.olv-cam-presets-label', { hasText: 'Views' }) })
    .locator('.olv-cam-presets');
}

test.describe('standard views — NavBar "Views" row', () => {
  test('the row mounts a chip for all six axis-aligned views', async ({ page }) => {
    await loadSample(page);
    const row = viewsRow(page);
    await expect(row).toBeVisible();
    for (const name of VIEW_NAMES) {
      const chip = row.locator('.olv-cam-chip').filter({ hasText: new RegExp(`^${name}$`) });
      await expect(chip, `missing standard-view chip "${name}"`).toBeVisible();
    }
  });

  test('clicking each view fires without a page error and toasts the route', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await loadSample(page);
    const row = viewsRow(page);
    const toast = page.locator('.olv-lasso-toast');
    for (const name of VIEW_NAMES) {
      await row.locator('.olv-cam-chip').filter({ hasText: new RegExp(`^${name}$`) }).click();
      await expect(toast).toHaveText(`View · ${name}.`);
    }
    expect(errors).toEqual([]);
  });
});

test.describe('orthographic toggle', () => {
  test('the Ortho chip toggles aria-pressed and toasts both states', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await loadSample(page);
    const ortho = viewsRow(page).locator('.olv-ortho-toggle');
    await expect(ortho).toBeVisible();
    await expect(ortho).toHaveAttribute('aria-pressed', 'false');

    const toast = page.locator('.olv-lasso-toast');
    await ortho.click();
    await expect(ortho).toHaveAttribute('aria-pressed', 'true');
    await expect(ortho).toHaveClass(/is-on/);
    await expect(toast).toHaveText('Orthographic (parallel) view on.');

    await ortho.click();
    await expect(ortho).toHaveAttribute('aria-pressed', 'false');
    await expect(toast).toHaveText('Perspective view restored.');

    expect(errors).toEqual([]);
  });
});
