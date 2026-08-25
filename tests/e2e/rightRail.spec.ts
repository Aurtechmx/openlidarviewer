import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyPly, railChromeSettled, expectHittable } from './helpers';

/**
 * tests/e2e/rightRail.spec.ts
 *
 * Integration coverage for the right context rail collapse (v0.6.5). The
 * Streaming card (when a COPC streams) and the Inspector now share ONE coherent
 * rail (`.olv-right-rail`) that collapses on a single grabber. This spec targets
 * that rail's handle by its `aria-controls` and asserts the state machine and
 * the layout invariant:
 *
 *   - the rail handle is hidden in the empty state (no scan);
 *   - after a scan it mounts, is visible, and starts expanded;
 *   - it sits against the column, not adrift at the viewport centre;
 *   - clicking it toggles `.olv-right-collapsed` on the rail and flips
 *     `aria-expanded`;
 *   - the choice persists across a reload (localStorage key below).
 */

const INSPECTOR = '.olv-right-rail';
const TAB = '.olv-right-rail-tab[aria-controls="olv-right-rail"]';
const KEY = 'olv.rightRail.inspector.collapsed';

async function loadSample(page: Page, url = '/'): Promise<void> {
  await suppressOnboardingTour(page);
  await page.goto(url);
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await railChromeSettled(page);
}

test('the Inspector handle is hidden in the empty state (no scan)', async ({ page }) => {
  await suppressOnboardingTour(page);
  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible();
  await expect(page.locator(TAB)).toBeHidden();
});

test('the Inspector handle mounts, is visible, and starts expanded', async ({ page }) => {
  await loadSample(page);
  const tab = page.locator(TAB);
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(INSPECTOR)).not.toHaveClass(/olv-right-collapsed/);
});

test('the Inspector handle sits against the column, not the viewport centre', async ({ page }) => {
  await loadSample(page);
  // The handle's `right` offset is transitioned over 420ms on a spring easing
  // (72-panel-rails.css), so this reads the geometry until it settles rather
  // than once after a fixed wait. The bound is unchanged.
  const offset = async (): Promise<number | null> => {
    const inspBox = await page.locator(INSPECTOR).boundingBox();
    const tabBox = await page.locator(TAB).boundingBox();
    if (!inspBox || !tabBox) return null;
    return tabBox.x + tabBox.width - inspBox.x;
  };
  await expect.poll(offset, { timeout: 15_000 }).not.toBeNull();
  await expect.poll(offset, { timeout: 15_000 }).toBeGreaterThanOrEqual(-8);
  expect(await offset()).toBeLessThanOrEqual(8);
});

test('clicking the Inspector handle collapses, then restores, the Inspector', async ({ page }) => {
  await loadSample(page);
  const tab = page.locator(TAB);
  const inspector = page.locator(INSPECTOR);

  await expectHittable(tab);
  await tab.click();
  await expect(inspector).toHaveClass(/olv-right-collapsed/);
  await expect(tab).toHaveAttribute('aria-expanded', 'false');

  await railChromeSettled(page);
  await expectHittable(tab);
  await tab.click();
  await expect(inspector).not.toHaveClass(/olv-right-collapsed/);
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
});

test('the Inspector collapsed choice persists across a reload', async ({ page }) => {
  await loadSample(page);
  await expectHittable(page.locator(TAB));
  await page.locator(TAB).click();
  await expect(page.locator(INSPECTOR)).toHaveClass(/olv-right-collapsed/);

  const stored = await page.evaluate((k) => localStorage.getItem(k), KEY);
  expect(stored).toBe('1');

  await page.reload();
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await railChromeSettled(page);
  await expect(page.locator(INSPECTOR)).toHaveClass(/olv-right-collapsed/);
  await expect(page.locator(TAB)).toHaveAttribute('aria-expanded', 'false');
});
