import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyPly } from './helpers';

/**
 * tests/e2e/leftRail.spec.ts
 *
 * Integration coverage for the v0.5.5 P11 premium left rail — the DOM +
 * localStorage wiring for the one-tap collapse and the measured dock
 * clearance. The two motivating defects (from the design screenshot):
 *
 *   1. the left column scrolled its last control (the Export button) UNDER
 *      the fixed bottom dock, so it was hidden / unreachable;
 *   2. there was no way to get the whole rail out of the way for a clean
 *      look at the scene.
 *
 * This spec is the live-DOM contract for both:
 *   - the grabber tab mounts, is visible on desktop, and reflects state via
 *     `aria-expanded`;
 *   - clicking it toggles `.olv-rail-collapsed` on `.olv-left-panels`;
 *   - the choice persists across a reload (localStorage `olv.leftRail.collapsed`);
 *   - when expanded, the column's bottom never overlaps the dock's top.
 *
 * The slide/opacity motion itself is CSS (and unit-testable only by eye); what
 * we assert here is the state machine and the layout invariant.
 */

const RAIL = '.olv-left-panels';
const TAB = '.olv-rail-tab';
const DOCK = '.olv-dock';

async function loadSample(page: Page, url = '/'): Promise<void> {
  await suppressOnboardingTour(page);
  await page.goto(url);
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

test('the grabber tab is hidden in the empty state (no scan, nothing to collapse)', async ({ page }) => {
  await suppressOnboardingTour(page);
  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible();
  // With no scan the rail holds no panels, so the grabber must not float on its own.
  await expect(page.locator(TAB)).toBeHidden();
});

test('the grabber tab mounts, is visible, and starts expanded', async ({ page }) => {
  await loadSample(page);
  const tab = page.locator(TAB);
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute('aria-controls', 'olv-left-panels');
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(RAIL)).not.toHaveClass(/olv-rail-collapsed/);
});

test('the grabber tab sits against the rail, not the viewport centre', async ({ page }) => {
  await loadSample(page);
  const railBox = await page.locator(RAIL).boundingBox();
  const tabBox = await page.locator(TAB).boundingBox();
  expect(railBox).not.toBeNull();
  expect(tabBox).not.toBeNull();
  if (railBox && tabBox) {
    const tabCentre = tabBox.y + tabBox.height / 2;
    // The tab's centre lands within the rail's vertical span (with a small margin),
    // never far below it at the viewport midpoint.
    expect(tabCentre).toBeGreaterThanOrEqual(railBox.y - 4);
    expect(tabCentre).toBeLessThanOrEqual(railBox.y + railBox.height + 4);
  }
});

test('clicking the tab collapses, then restores, the whole rail', async ({ page }) => {
  await loadSample(page);
  const tab = page.locator(TAB);
  const rail = page.locator(RAIL);

  await tab.click();
  await expect(rail).toHaveClass(/olv-rail-collapsed/);
  await expect(tab).toHaveAttribute('aria-expanded', 'false');

  await tab.click();
  await expect(rail).not.toHaveClass(/olv-rail-collapsed/);
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
});

test('the collapsed choice persists across a reload', async ({ page }) => {
  await loadSample(page);
  await page.locator(TAB).click();
  await expect(page.locator(RAIL)).toHaveClass(/olv-rail-collapsed/);

  // The rail state is keyed on localStorage; a reload must restore it.
  const stored = await page.evaluate(() => localStorage.getItem('olv.leftRail.collapsed'));
  expect(stored).toBe('1');

  // Reload and re-drop a scan; the rail must come back collapsed from storage.
  await page.reload();
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await expect(page.locator(RAIL)).toHaveClass(/olv-rail-collapsed/);
  await expect(page.locator(TAB)).toHaveAttribute('aria-expanded', 'false');
});

test('the expanded column never overlaps the bottom dock (P11 clearance)', async ({ page }) => {
  await loadSample(page);
  const rail = page.locator(RAIL);
  await expect(rail).toBeVisible();
  const dock = page.locator(DOCK);
  await expect(dock).toBeVisible();

  const railBox = await rail.boundingBox();
  const dockBox = await dock.boundingBox();
  expect(railBox).not.toBeNull();
  expect(dockBox).not.toBeNull();
  if (railBox && dockBox) {
    // The measured --olv-dock-clear caps the column's max-height so its
    // bottom edge ends at or above the dock's top edge — the last control
    // (Export) can never scroll under the dock. A 1px tolerance absorbs
    // sub-pixel rounding.
    expect(railBox.y + railBox.height).toBeLessThanOrEqual(dockBox.y + 1);
  }
});
