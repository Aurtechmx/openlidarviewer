import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyPly } from './helpers';

/**
 * tests/e2e/rightRail.spec.ts
 *
 * Integration coverage for the right-column collapse — the mirror of the left
 * rail. A single grabber slides BOTH right panels (the Streaming/COPC card and
 * the Inspector) out to the screen's right edge. Unlike the left rail these are
 * two separate absolutely-positioned elements, so the collapse class is applied
 * to each; here we assert the state machine and the layout invariant:
 *
 *   - the grabber is hidden in the empty state (no scan, nothing to collapse);
 *   - after a scan it mounts, is visible, and starts expanded;
 *   - it sits against the right column, not adrift at the viewport centre;
 *   - clicking it toggles `.olv-right-collapsed` on the Inspector and flips
 *     `aria-expanded`;
 *   - the choice persists across a reload (localStorage `olv.rightRail.collapsed`).
 */

const INSPECTOR = '.olv-inspector';
const TAB = '.olv-right-rail-tab';

async function loadSample(page: Page, url = '/'): Promise<void> {
  await suppressOnboardingTour(page);
  await page.goto(url);
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

test('the right grabber is hidden in the empty state (no scan, nothing to collapse)', async ({ page }) => {
  await suppressOnboardingTour(page);
  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible();
  // With no scan the Inspector carries `olv-hidden`, so the grabber must not float on its own.
  await expect(page.locator(TAB)).toBeHidden();
});

test('the right grabber mounts, is visible, and starts expanded', async ({ page }) => {
  await loadSample(page);
  const tab = page.locator(TAB);
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(INSPECTOR)).not.toHaveClass(/olv-right-collapsed/);
});

test('the right grabber sits against the column, not the viewport centre', async ({ page }) => {
  await loadSample(page);
  const inspBox = await page.locator(INSPECTOR).boundingBox();
  const tabBox = await page.locator(TAB).boundingBox();
  expect(inspBox).not.toBeNull();
  expect(tabBox).not.toBeNull();
  if (inspBox && tabBox) {
    // The grabber rides the column's left (canvas-facing) edge: its right edge
    // lands at or just left of the Inspector's left edge, never far away.
    const tabRight = tabBox.x + tabBox.width;
    expect(tabRight).toBeGreaterThanOrEqual(inspBox.x - 8);
    expect(tabRight).toBeLessThanOrEqual(inspBox.x + 8);
  }
});

test('clicking the right grabber collapses, then restores, the column', async ({ page }) => {
  await loadSample(page);
  const tab = page.locator(TAB);
  const inspector = page.locator(INSPECTOR);

  await tab.click();
  await expect(inspector).toHaveClass(/olv-right-collapsed/);
  await expect(tab).toHaveAttribute('aria-expanded', 'false');

  await tab.click();
  await expect(inspector).not.toHaveClass(/olv-right-collapsed/);
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
});

test('the right collapsed choice persists across a reload', async ({ page }) => {
  await loadSample(page);
  await page.locator(TAB).click();
  await expect(page.locator(INSPECTOR)).toHaveClass(/olv-right-collapsed/);

  const stored = await page.evaluate(() => localStorage.getItem('olv.rightRail.collapsed'));
  expect(stored).toBe('1');

  await page.reload();
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await expect(page.locator(INSPECTOR)).toHaveClass(/olv-right-collapsed/);
  await expect(page.locator(TAB)).toHaveAttribute('aria-expanded', 'false');
});
