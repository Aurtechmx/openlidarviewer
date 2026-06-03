import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * Visuals Studio — mobile viewport contract.
 *
 * The Inspector bottom-sheet is the primary entry point for visual
 * controls on phones. The Visuals Studio section adds three chip rails,
 * an Advanced disclosure and two slider rows; the mobile CSS layer
 * (see @media (max-width: 767px) in src/style.css) bumps each of those
 * surfaces to a 44 pt thumb-friendly target. This spec pins the touch
 * target dimensions so a future stylesheet refactor doesn't silently
 * regress mobile UX.
 *
 * Two viewports are exercised:
 *   - 375 × 667  iPhone SE / 8 / 12 mini baseline
 *   - 320 × 568  smallest practical phone — the layout must not break
 */

const PHONES: ReadonlyArray<{ name: string; width: number; height: number }> = [
  { name: 'iphone-se-375', width: 375, height: 667 },
  { name: 'smallest-320', width: 320, height: 568 },
];

async function loadOnPhoneAndOpenSheet(
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);

  // v0.3.9 mobile UX — the Inspector is now a peek-and-expand bottom
  // sheet on phones. The head bar (with "Scan Intelligence" title +
  // chevron) is always visible at the bottom of the viewport and tap
  // toggles the sheet open. The standalone floating "Scan Info"
  // button (.olv-scaninfo-btn) was removed because it duplicated the
  // peeked head; tests target the head directly.
  const sheetHead = page.locator('.olv-inspector .olv-panel-head');
  await expect(sheetHead).toBeVisible({ timeout: 8_000 });
  await sheetHead.click();
  // The Inspector slides up; wait for the sheet-open transform.
  await expect(page.locator('.olv-inspector.olv-sheet-open')).toBeVisible({
    timeout: 4_000,
  });

  // Visuals Studio opens by default; guard against a future default
  // change identical to the desktop spec.
  const visualsDetails = page.locator('details.olv-section-collapsible', {
    has: page.locator('summary', { hasText: 'Visuals Studio' }),
  });
  const isOpen = await visualsDetails.evaluate(
    (el) => (el as HTMLDetailsElement).open,
  );
  if (!isOpen) {
    await visualsDetails.locator('summary').click();
  }
}

for (const phone of PHONES) {
  test.describe(`Visuals Studio on ${phone.name}`, () => {
    test('Visuals Studio surfaces all three chip rails on mobile', async ({
      page,
    }) => {
      await loadOnPhoneAndOpenSheet(page, phone.width, phone.height);

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

    test('Visuals Studio chips meet 44 px touch-target minimum', async ({
      page,
    }) => {
      await loadOnPhoneAndOpenSheet(page, phone.width, phone.height);

      // Every chip in the three visible rails must be at least 44 pt
      // tall — the iOS HIG and Material Design baseline. Scope to the
      // `.olv-chips` rails so the Advanced > Auto-balance chip (hidden
      // inside a collapsed <details>) doesn't fail the assertion with
      // a 0-height box.
      const chips = page.locator('.olv-visuals-body .olv-chips .olv-chip');
      const count = await chips.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const box = await chips.nth(i).boundingBox();
        expect(box, `chip ${i} should have a bounding box`).not.toBeNull();
        // 44 - 1 to allow for sub-pixel rounding (e.g. 43.5 → 44 reads
        // as 43.99 in some browsers).
        expect(box!.height).toBeGreaterThanOrEqual(43.5);
      }
    });

    // (Advanced disclosure / WB sliders removed in v0.3.8; the
    // touch-target check has nothing to assert against now.)

    test('Keyboard NavWidget (.olv-navbar) is hidden on mobile', async ({
      page,
    }) => {
      // The mode switcher (Orbit / Fly / Zoom) is keyboard-driven —
      // phones have no keyboard, so it's removed entirely on phones.
      // Touch users drive the camera via the 2-finger recogniser.
      await loadOnPhoneAndOpenSheet(page, phone.width, phone.height);
      const navbar = page.locator('.olv-navbar');
      const count = await navbar.count();
      if (count > 0) {
        await expect(navbar).toBeHidden();
      }
    });

    test('Section summaries (Visuals Studio / Rendering) hit 44 pt', async ({
      page,
    }) => {
      await loadOnPhoneAndOpenSheet(page, phone.width, phone.height);

      const summaries = page.locator('.olv-section-summary');
      const count = await summaries.count();
      expect(count).toBeGreaterThan(0);
      // Sample the first three — they're the most prominent above the
      // fold and any regression here will hit the user the hardest.
      for (let i = 0; i < Math.min(3, count); i++) {
        const box = await summaries.nth(i).boundingBox();
        if (box === null) continue;
        expect(box.height).toBeGreaterThanOrEqual(43.5);
      }
    });
  });
}
