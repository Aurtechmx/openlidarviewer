import { test, expect } from '@playwright/test';
import { dropTerrainAccessUtmLas, showWorkspaceMode } from './helpers';

// The post-load suggestion ("Terrain scan ready…") is made for the task the
// user was on. Moving to another task hides it instead of leaving it over the
// new task's controls until its timer runs out.
test('the scan-ready suggestion hides when the user switches task', async ({ page }) => {
  await page.goto('/?test=1');
  await dropTerrainAccessUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  const suggestion = page.locator('.olv-lasso-toast.olv-visible', { has: page.locator('.olv-lasso-toast-action') });
  await expect(suggestion).toContainText('scan ready', { timeout: 15_000 });
  await showWorkspaceMode(page, 'work');
  await expect(suggestion).toHaveCount(0);
});
