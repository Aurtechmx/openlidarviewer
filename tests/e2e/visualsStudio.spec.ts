import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * v0.3.8 Stream A — Visuals Studio e2e.
 *
 * The collapsible "Visuals Studio" Inspector section surfaces three
 * chip rails — RGB / Depth (EDL) / Background — plus an Advanced
 * disclosure with white-balance sliders and an Auto-balance button.
 * This spec pins:
 *   - the section is present once a scan is loaded
 *   - opening it reveals each chip rail with the documented chip
 *     count
 *   - clicking a chip flips the .olv-chip-active class to the right
 *     button (the syncVisuals round-trip)
 *   - the Advanced disclosure exposes the WB sliders + Auto-balance
 *
 * Reconstruction maths is unit-tested at the data layer
 * (`tests/rgbAppearance.test.ts`, `tests/edlPresets.test.ts`,
 * `tests/localDensitySizeAndSky.test.ts`); this spec is the live-DOM
 * contract.
 */

async function loadSampleAndOpenVisuals(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  // Visuals Studio opens by default. Guard against a future default
  // change by clicking the summary only when the <details> isn't open.
  // Reading the `open` attribute keeps the assertion order-independent.
  const visualsDetails = page.locator('details.olv-section-collapsible', {
    has: page.locator('summary', { hasText: 'Visuals Studio' }),
  });
  const isOpen = await visualsDetails.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) {
    await visualsDetails.locator('summary').click();
  }
}

test('Visuals Studio surfaces all three chip rails', async ({ page }) => {
  await loadSampleAndOpenVisuals(page);
  // The three group labels read RGB / Depth (EDL) / Background.
  await expect(
    page.locator('.olv-visuals-group-label', { hasText: 'RGB' }),
  ).toBeVisible();
  await expect(
    page.locator('.olv-visuals-group-label', { hasText: 'Depth (EDL)' }),
  ).toBeVisible();
  await expect(
    page.locator('.olv-visuals-group-label', { hasText: 'Background' }),
  ).toBeVisible();
});

test('RGB rail has six chips and clicking one flips .olv-chip-active', async ({ page }) => {
  await loadSampleAndOpenVisuals(page);
  // Walk up from the "RGB" label to its sibling rail. Use the first
  // `.olv-chips` rail inside `.olv-visuals-body` — that's the RGB
  // rail in mount order.
  const rails = page.locator('.olv-visuals-body .olv-chips');
  const rgbRail = rails.nth(0);
  await expect(rgbRail.locator('.olv-chip')).toHaveCount(6);

  const drone = rgbRail.locator('.olv-chip', { hasText: 'Drone RGB' });
  await drone.click();
  await expect(drone).toHaveClass(/olv-chip-active/);
});

test('EDL rail has four chips including Off', async ({ page }) => {
  await loadSampleAndOpenVisuals(page);
  const rails = page.locator('.olv-visuals-body .olv-chips');
  const edlRail = rails.nth(1);
  await expect(edlRail.locator('.olv-chip')).toHaveCount(4);
  await expect(edlRail.locator('.olv-chip', { hasText: 'Off' })).toBeVisible();
  await expect(edlRail.locator('.olv-chip', { hasText: 'Subtle' })).toBeVisible();
  await expect(edlRail.locator('.olv-chip', { hasText: 'Balanced' })).toBeVisible();
  await expect(edlRail.locator('.olv-chip', { hasText: 'Inspection' })).toBeVisible();
});

test('Background rail has five chips and Black is selectable', async ({ page }) => {
  await loadSampleAndOpenVisuals(page);
  const rails = page.locator('.olv-visuals-body .olv-chips');
  const skyRail = rails.nth(2);
  await expect(skyRail.locator('.olv-chip')).toHaveCount(5);
  const black = skyRail.locator('.olv-chip', { hasText: 'Black' });
  await black.click();
  await expect(black).toHaveClass(/olv-chip-active/);
});

test('Desktop applies the rich radial gradient on the canvas parent', async ({ page }) => {
  // Wider-than-767 viewport gets the full gradient — the radial
  // string `background-image` reads as a `radial-gradient(...)`.
  await page.setViewportSize({ width: 1280, height: 800 });
  await loadSampleAndOpenVisuals(page);
  const rails = page.locator('.olv-visuals-body .olv-chips');
  await rails.nth(2).locator('.olv-chip', { hasText: 'Studio Dark' }).click();
  await page.waitForTimeout(120);
  const bgImage = await page
    .locator('.olv-canvas')
    .evaluate((el) => {
      const parent = el.parentElement;
      return parent ? getComputedStyle(parent).backgroundImage : null;
    });
  expect(bgImage).toContain('radial-gradient');
});

test('Phone uses the flat fallback colour (no gradient bleed under chrome)', async ({ page }) => {
  // Below the 767 px breakpoint the gradient is suppressed so the
  // sky does not bleed behind the bottom sheet / topbar. On phones
  // the Inspector is a peek-and-expand bottom sheet — the head bar
  // is always visible and tap toggles it open. The standalone
  // floating Scan Info launcher was retired in v0.3.9.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
  const sheetHead = page.locator('.olv-inspector .olv-panel-head');
  await expect(sheetHead).toBeVisible({ timeout: 8_000 });
  await sheetHead.click();
  await expect(page.locator('.olv-inspector.olv-sheet-open')).toBeVisible({
    timeout: 4_000,
  });
  const visualsDetails = page.locator('details.olv-section-collapsible', {
    has: page.locator('summary', { hasText: 'Visuals Studio' }),
  });
  const isOpen = await visualsDetails.evaluate(
    (el) => (el as HTMLDetailsElement).open,
  );
  if (!isOpen) await visualsDetails.locator('summary').click();

  const rails = page.locator('.olv-visuals-body .olv-chips');
  await rails.nth(2).locator('.olv-chip', { hasText: 'Studio Dark' }).click();
  await page.waitForTimeout(120);
  const bgImage = await page
    .locator('.olv-canvas')
    .evaluate((el) => {
      const parent = el.parentElement;
      return parent ? getComputedStyle(parent).backgroundImage : null;
    });
  // CSS `background: <flat-hex>` resolves to `background-image: none`
  // — the radial gradient is intentionally absent on phones.
  expect(bgImage).toBe('none');
});

test('Background chip click actually updates the canvas container background', async ({ page }) => {
  // Regression guard for the "Background buttons do nothing" report.
  // Two layers must update on click:
  //   1. CSS background on the canvas parent (visible at sheet edges
  //      + matches the rendered colour for screenshots).
  //   2. The renderer's scene background (what the canvas actually
  //      clears to each frame). We can't reach into Three.js from
  //      Playwright easily, but the CSS leg is a faithful proxy:
  //      `_applySkyPreset` updates both atomically, so a successful
  //      CSS change proves the call ran end-to-end.
  await loadSampleAndOpenVisuals(page);
  const rails = page.locator('.olv-visuals-body .olv-chips');
  const skyRail = rails.nth(2);

  // Click Black — fallback colour is #000000.
  await skyRail.locator('.olv-chip', { hasText: 'Black' }).click();
  await page.waitForTimeout(120);
  const blackBg = await page
    .locator('.olv-canvas')
    .evaluate((el) => {
      const parent = el.parentElement;
      return parent ? getComputedStyle(parent).backgroundColor : null;
    });
  expect(blackBg).toBe('rgb(0, 0, 0)');

  // Click Studio Dark — fallback #0B0F14 → rgb(11, 15, 20).
  await skyRail.locator('.olv-chip', { hasText: 'Studio Dark' }).click();
  await page.waitForTimeout(120);
  const studioBg = await page
    .locator('.olv-canvas')
    .evaluate((el) => {
      const parent = el.parentElement;
      return parent ? getComputedStyle(parent).backgroundColor : null;
    });
  expect(studioBg).toBe('rgb(11, 15, 20)');
});

// (Advanced disclosure / WB sliders / Auto-balance were removed —
// the RGB preset chips above carry the same intent in one click.)
