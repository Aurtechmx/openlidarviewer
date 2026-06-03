import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * Per-kind selection round-trip for the v0.3.7 measurement picker.
 *
 * The picker shipped as a 9-button row in v0.3.7 (volume + box landed in
 * Stream B). The existing measure.spec.ts asserts the row's *count*; this
 * spec asserts the row's *behaviour* — every kind is independently
 * selectable, and clicking a kind moves the .olv-mkind-active class to
 * the right button. Catches the regression class where a kind is rendered
 * but its click handler is wired to a stale enum value.
 */

const EVERY_KIND = [
  'Distance',
  'Polyline',
  'Area',
  'Height',
  'Angle',
  'Slope',
  'Profile',
  'Volume',
  'Box',
] as const;

async function loadSampleAndMeasure(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  // Let the framing tween settle so the picker is interactive.
  await page.waitForTimeout(1500);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
}

test('each measurement kind becomes active when its button is clicked', async ({ page }) => {
  await loadSampleAndMeasure(page);

  // Verify every kind exists by label — the v0.3.7 measure-bar order
  // is documented inline in the spec so a renderer reorder still
  // exercises every kind by name.
  for (const label of EVERY_KIND) {
    const btn = page.locator('.olv-mkind', { hasText: new RegExp(`^${label}$`) });
    await expect(btn, `missing kind button "${label}"`).toBeVisible();
  }

  // Click each kind in turn, assert it carries .olv-mkind-active.
  // Walking the full set catches both "click bound to wrong kind" and
  // "active class never moves off the default".
  //
  // v0.3.8: clicking the currently-active kind exits measure mode
  // (the "click again to exit" affordance). Distance is the default
  // active kind, so we step away from it first via Polyline before
  // iterating the full set — that way every loop iteration is a
  // transition from one kind to a DIFFERENT kind.
  await page.locator('.olv-mkind', { hasText: /^Polyline$/ }).click();
  await expect(page.locator('.olv-mkind-active')).toHaveText('Polyline');
  for (const label of EVERY_KIND) {
    if (label === 'Polyline') continue;
    const btn = page.locator('.olv-mkind', { hasText: new RegExp(`^${label}$`) });
    await btn.click();
    await expect(page.locator('.olv-mkind-active')).toHaveText(label);
  }
});

test('the default active kind is Distance', async ({ page }) => {
  await loadSampleAndMeasure(page);
  // The measurement controller initialises with Distance — this guards
  // against a default-kind regression that would otherwise only surface
  // when an analyst opens the panel and clicks the canvas.
  await expect(page.locator('.olv-mkind-active')).toHaveText('Distance');
});
