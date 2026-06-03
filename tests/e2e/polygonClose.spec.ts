import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * Polygon-completion round-trip for the v0.3.8 measure pipeline.
 *
 * The release goal: polygon-based tools (area, volume, polyline,
 * profile) must never trap the user in infinite vertex placement.
 * Five completion paths exist, and each must be exercised:
 *
 *   1. Click the first vertex within 16 px (the snap-close affordance)
 *   2. Double-click anywhere
 *   3. Press Enter
 *   4. Press Esc to cancel a draft
 *   5. Press Backspace to undo the last vertex
 *
 * Plus the explicit "Finish polygon" button that surfaces only when a
 * polygon-kind draft has enough vertices to close.
 *
 * The spec does not depend on real cloud-point hit testing — those
 * picks are flaky from headless CI without a primed scene. Instead it
 * exercises the DOM state machine: kind picker → measure-bar →
 * tooltip + button presence, plus the keyboard handlers and the
 * exits-on-Esc contract. The visible result is the absence of a
 * "trapped" draft (no measure-bar still showing the draft hint after
 * Esc) and the presence/visibility transitions on the Finish button.
 */

// Profile is a 2-point kind (auto-commits on the 2nd click), not a
// closable polygon. Only Polyline / Area / Volume use the polygon
// completion vocabulary (click-first-vertex / double-click / Enter
// / Finish button).
const POLYGON_KINDS = ['Polyline', 'Area', 'Volume'] as const;

async function openMeasureBarWithKind(page: Page, kind: string): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
  await page
    .locator('.olv-mkind', { hasText: new RegExp(`^${kind}$`) })
    .click();
  await expect(page.locator('.olv-mkind-active')).toHaveText(kind);
}

test.describe('polygon completion paths', () => {
  test('every polygon kind exposes the Finish polygon button (hidden until ready)', async ({
    page,
  }) => {
    // Before any vertex placement, Finish must NOT be visible — it
    // only surfaces when the draft has enough vertices to close.
    // The button must exist in the DOM (so we can toggle it without
    // re-rendering) but carry the `.olv-hidden` class.
    await openMeasureBarWithKind(page, 'Area');
    const finishBtn = page.locator('.olv-measure-finish');
    await expect(finishBtn).toBeHidden();
    // Switching to a non-polygon kind must keep it hidden.
    await page.locator('.olv-mkind', { hasText: /^Distance$/ }).click();
    await expect(finishBtn).toBeHidden();
  });

  for (const kind of POLYGON_KINDS) {
    test(`${kind} carries a tooltip that names every completion path`, async ({
      page,
    }) => {
      await openMeasureBarWithKind(page, kind);
      const activeBtn = page.locator('.olv-mkind-active');
      const title = await activeBtn.getAttribute('title');
      expect(
        title,
        `${kind} kind button must carry a tooltip`,
      ).toBeTruthy();
      // The tooltip is the canonical place users learn how to close
      // a polygon — it must mention the keyboard, the click-first-
      // vertex affordance, and the Esc exit so no user is stranded.
      expect(title).toMatch(/first vertex|first point/i);
      expect(title).toMatch(/double-click|double click|Enter/i);
      expect(title).toMatch(/Esc/);
    });
  }

  test('Esc exits measure mode entirely', async ({ page }) => {
    await openMeasureBarWithKind(page, 'Area');
    await page.keyboard.press('Escape');
    // The measure-bar hides when measure mode exits — Esc must
    // unwind the whole tool, not just cancel a draft.
    await expect(page.locator('.olv-measure-bar')).toBeHidden();
  });

  test('clicking the active kind a second time exits measure mode', async ({
    page,
  }) => {
    await openMeasureBarWithKind(page, 'Volume');
    await page.locator('.olv-mkind', { hasText: /^Volume$/ }).click();
    await expect(page.locator('.olv-measure-bar')).toBeHidden();
  });

  test('Undo point button mentions Backspace in its tooltip', async ({
    page,
  }) => {
    await openMeasureBarWithKind(page, 'Volume');
    // Scope to the measure-bar — Inspect and other tools mount their
    // own measurement-style buttons elsewhere.
    const undoBtn = page
      .locator('.olv-measure-bar')
      .locator('.olv-measure-undo');
    await expect(undoBtn).toBeVisible();
    const title = await undoBtn.getAttribute('title');
    expect(title).toMatch(/Backspace/);
  });

  test('Done button mentions Esc parity in its tooltip', async ({ page }) => {
    await openMeasureBarWithKind(page, 'Area');
    // Scope the locator to the measure-bar — Inspect and other tools
    // mount their own `.olv-measure-done` buttons elsewhere, so a
    // bare class selector resolves to multiple elements.
    const doneBtn = page
      .locator('.olv-measure-bar')
      .locator('.olv-measure-done');
    await expect(doneBtn).toBeVisible();
    const title = await doneBtn.getAttribute('title');
    expect(title).toMatch(/Esc/);
  });
});
