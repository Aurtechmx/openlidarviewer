import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly, dropDenseGridPly } from './helpers';

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

test('an angle placed on the vertices of an existing polyline uses those vertices', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
  // Setup only: a polyline A-B-C with a right angle at A.
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__?: {
      setMeasureKind: (k: string) => void;
      placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
      finishMeasurement?: () => void;
    } }).__OLV_TEST_API__;
    if (!api) throw new Error('__OLV_TEST_API__ not mounted');
    api.setMeasureKind('polyline');
    api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 3, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 0, y: 3, z: 0 });
    api.finishMeasurement?.();
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });

  // The Navigation card floats over the middle of the scene; close it so the
  // handles under it are reachable.
  const navClose = page.locator('.olv-nav-hud-close');
  if (await navClose.isVisible()) await navClose.click();
  // Real clicks on the polyline's vertex handles: B, then the vertex A, then C.
  await page.locator('.olv-mkind', { hasText: /^Angle$/ }).click();
  for (const vi of [1, 0, 2]) {
    const handle = page.locator(`.olv-m-handle[data-vi="${vi}"]`).first();
    // The overlay redraws its handles on every rendered frame, so the node can
    // be replaced between a lookup and a read. Clicking through the locator
    // resolves the current node at the moment of the click.
    await handle.click();
  }
  await expect(page.locator('.olv-mp-row')).toHaveCount(2);
  await expect(page.locator('.olv-mp-row').nth(1).locator('.olv-mp-value')).toContainText('90');
});
