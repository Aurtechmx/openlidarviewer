import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyPly } from './helpers';

/**
 * tests/e2e/rightRail.spec.ts
 *
 * Integration coverage for the right-column collapse. Each right panel has its
 * OWN grabber, centred on that panel, so the Streaming card (top, only while a
 * COPC streams) and the Inspector (bottom, or full-height otherwise) collapse
 * independently. A plain scan (tiny PLY) shows only the Inspector, so this spec
 * targets the Inspector's handle by its `aria-controls` and asserts the state
 * machine and the layout invariant:
 *
 *   - the Inspector handle is hidden in the empty state (no scan);
 *   - after a scan it mounts, is visible, and starts expanded;
 *   - it sits against the column, not adrift at the viewport centre;
 *   - clicking it toggles `.olv-right-collapsed` on the Inspector and flips
 *     `aria-expanded`;
 *   - the choice persists across a reload (localStorage key below).
 */

const INSPECTOR = '.olv-inspector';
const TAB = '.olv-right-rail-tab[aria-controls="olv-inspector"]';
const KEY = 'olv.rightRail.inspector.collapsed';

async function loadSample(page: Page, url = '/'): Promise<void> {
  await suppressOnboardingTour(page);
  await page.goto(url);
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
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
  const inspBox = await page.locator(INSPECTOR).boundingBox();
  const tabBox = await page.locator(TAB).boundingBox();
  expect(inspBox).not.toBeNull();
  expect(tabBox).not.toBeNull();
  if (inspBox && tabBox) {
    const tabRight = tabBox.x + tabBox.width;
    expect(tabRight).toBeGreaterThanOrEqual(inspBox.x - 8);
    expect(tabRight).toBeLessThanOrEqual(inspBox.x + 8);
  }
});

test('clicking the Inspector handle collapses, then restores, the Inspector', async ({ page }) => {
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

test('the Inspector collapsed choice persists across a reload', async ({ page }) => {
  await loadSample(page);
  await page.locator(TAB).click();
  await expect(page.locator(INSPECTOR)).toHaveClass(/olv-right-collapsed/);

  const stored = await page.evaluate((k) => localStorage.getItem(k), KEY);
  expect(stored).toBe('1');

  await page.reload();
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await expect(page.locator(INSPECTOR)).toHaveClass(/olv-right-collapsed/);
  await expect(page.locator(TAB)).toHaveAttribute('aria-expanded', 'false');
});
