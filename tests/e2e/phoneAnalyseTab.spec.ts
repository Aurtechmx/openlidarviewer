import { test, expect, type Page } from '@playwright/test';
import { dropTerrainAccessUtmLas, showWorkspaceMode } from './helpers';

/**
 * The Analyse tab on a phone.
 *
 * Below the phone breakpoint the desktop rail is hidden and the workspace modes
 * live in the bottom sheet, so Analyse is the sheet's `.olv-msheet-tab`, not the
 * rail's `.olv-ws-tab`. A real touch tap on it opens the Analyse home, and Flow
 * Pulse opens from there. Checked at the three phone sizes the layout targets.
 */

const SIZES = [
  { width: 375, height: 812 },
  { width: 320, height: 700 },
  { width: 390, height: 844 },
];

async function openScan(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropTerrainAccessUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.olv-mobile-sheet')).toBeVisible({ timeout: 10_000 });
}

for (const viewport of SIZES) {
  test.describe(`phone Analyse tab ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test('a tap on the Analyse tab opens Analyse, and Flow Pulse opens from it', async ({ page }) => {
      test.setTimeout(120_000);
      await openScan(page);
      const tab = page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="analyse"]');
      await expect(tab).toBeVisible();

      // Nothing covers the tab: the element at its centre is the tab itself.
      const box = await tab.boundingBox();
      expect(box, 'the Analyse tab has a box').not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44 - 1);
      expect(box!.height).toBeGreaterThanOrEqual(44 - 1);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('.olv-msheet-tab')?.getAttribute('data-tab') ?? el?.className ?? null;
      }, [box!.x + box!.width / 2, box!.y + box!.height / 2]);
      expect(hit).toBe('analyse');

      await tab.tap();
      const slot = page.locator('.olv-msheet-slot[data-tab="analyse"]');
      await expect(slot).toHaveClass(/is-active/);
      const row = slot.locator('.olv-ah-row[data-analysis="flow-pulse"]');
      await expect(row).toBeVisible({ timeout: 20_000 });

      await row.locator('.olv-ah-open').tap();
      await expect(page.locator('.olv-analyse-page[data-page="flow-pulse"]')).toBeVisible({ timeout: 20_000 });
      await expect(slot.locator('.olv-ws-task-title')).toHaveText('Flow Pulse');
    });
  });
}

test.describe('showWorkspaceMode at a phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('opens Analyse through the sheet instead of waiting on the hidden rail tab', async ({ page }) => {
    test.setTimeout(60_000);
    await openScan(page);
    await showWorkspaceMode(page, 'analyse');
    await expect(page.locator('.olv-msheet-slot[data-tab="analyse"]')).toHaveClass(/is-active/);
    await expect(page.locator('.olv-ah-row[data-analysis="flow-pulse"]')).toBeVisible({ timeout: 20_000 });
  });
});
