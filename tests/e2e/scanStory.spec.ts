import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * Dataset Story + Export Health — the fitness-for-use synthesis surfaced via the
 * command palette. The synthesis + renderers are unit-tested
 * (scanStory.test.ts, scanStoryViews.test.ts); this spec pins the real user
 * surface: a loaded scan, the palette actions, and the modal landing with the
 * rendered card / health summary.
 *
 * Runs against the production preview (needs a real WebGL/WebGPU context).
 */

async function firePaletteAction(page: Page, query: string, rowText: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill(query);
  await expect(page.locator('.olv-palette-row', { hasText: rowText })).toBeVisible();
  await page.locator('.olv-palette-input').press('Enter');
  await expect(page.locator('.olv-palette')).toBeHidden();
}

test('Dataset Story action opens a card with headline, limiter and next step', async ({ page }) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  await firePaletteAction(page, 'Dataset Story', 'Dataset Story');

  const card = page.locator('.olv-story-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.olv-story-title')).toHaveText('Dataset Story');
  await expect(card.locator('.olv-story-assess')).toBeVisible();
  // The card always carries a primary-limiter row and a next-step line.
  await expect(card).toContainText('Primary limiter');
  await expect(card.locator('.olv-story-next')).toContainText('→');
});

test('Export health check action opens a verdict + per-axis rows', async ({ page }) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  await firePaletteAction(page, 'Export health', 'Export health check');

  const health = page.locator('.olv-health');
  await expect(health).toBeVisible();
  await expect(health.locator('.olv-health-verdict')).toBeVisible();
  // Scope + classification are always present rows.
  await expect(health).toContainText('Scan scope');
  await expect(health).toContainText('Classification');
});
