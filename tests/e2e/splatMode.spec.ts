import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * Stream B — Splat mode chip rail e2e.
 *
 * The Rendering > Splat mode rail surfaces three chips (Classic
 * Points · Soft Splats · Inspection Splats) that drive
 * `viewer.setSplatMode`. This spec is the live-DOM contract:
 *   - the three chips render
 *   - the active chip is reflected via `.olv-chip-active`
 *   - clicking a chip round-trips through the callback + sync pass
 *
 * Renderer-side maths is unit-tested at the data layer
 * (`tests/splatShader.test.ts`); this spec is the UI surface.
 */

async function loadAndOpenRendering(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  // Rendering section is collapsible and default-closed since the
  // Inspector reorder. Open it.
  const renderingDetails = page.locator('details.olv-section-collapsible', {
    has: page.locator('summary', { hasText: 'Rendering' }),
  });
  const isOpen = await renderingDetails.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) {
    await renderingDetails.locator('summary').click();
  }
}

test('Point appearance rail surfaces three chips', async ({ page }) => {
  await loadAndOpenRendering(page);
  // v0.5.5 P13 renamed the "Splat mode" sublabel to "Point appearance".
  const sublabel = page.locator('.olv-render-sublabel', { hasText: 'Point appearance' });
  await expect(sublabel).toBeVisible();
  // The splat rail sits immediately after its sublabel inside the
  // rendering group. Three chips: Classic / Soft / Inspection.
  await expect(
    page.locator('.olv-chip', { hasText: 'Classic Points' }),
  ).toBeVisible();
  await expect(
    page.locator('.olv-chip', { hasText: 'Soft Splats' }),
  ).toBeVisible();
  await expect(
    page.locator('.olv-chip', { hasText: 'Inspection Splats' }),
  ).toBeVisible();
});

test('Classic Points is active by default (preserves v0.3.7 baseline perf)', async ({ page }) => {
  await loadAndOpenRendering(page);
  const classic = page.locator('.olv-chip', { hasText: 'Classic Points' });
  await expect(classic).toHaveClass(/olv-chip-active/);
});

test('Clicking Soft Splats flips the active flag onto Soft', async ({ page }) => {
  await loadAndOpenRendering(page);
  const soft = page.locator('.olv-chip', { hasText: 'Soft Splats' });
  await soft.click();
  await expect(soft).toHaveClass(/olv-chip-active/);
  // The previously-active Classic chip drops the active flag — only
  // one chip can be active at a time.
  await expect(
    page.locator('.olv-chip', { hasText: 'Classic Points' }),
  ).not.toHaveClass(/olv-chip-active/);
});

test('Clicking Inspection Splats activates that chip', async ({ page }) => {
  await loadAndOpenRendering(page);
  const inspection = page.locator('.olv-chip', { hasText: 'Inspection Splats' });
  await inspection.click();
  await expect(inspection).toHaveClass(/olv-chip-active/);
});

test('the Gaussian chip renders with the honest, non-3DGS tooltip (P13)', async ({ page }) => {
  await loadAndOpenRendering(page);
  const gaussian = page.locator('.olv-chip', { hasText: 'Gaussian' });
  await expect(gaussian).toBeVisible();
  // Honesty contract: the tooltip must state this is NOT a trained 3D Gaussian Splat scene.
  await expect(gaussian).toHaveAttribute(
    'title',
    'Gaussian-shaped point rendering. This smooths ordinary point samples and is not a trained 3D Gaussian Splat scene.',
  );
});

test('Clicking Gaussian activates that chip and clears the others', async ({ page }) => {
  await loadAndOpenRendering(page);
  const gaussian = page.locator('.olv-chip', { hasText: 'Gaussian' });
  await gaussian.click();
  await expect(gaussian).toHaveClass(/olv-chip-active/);
  await expect(
    page.locator('.olv-chip', { hasText: 'Classic Points' }),
  ).not.toHaveClass(/olv-chip-active/);
});
