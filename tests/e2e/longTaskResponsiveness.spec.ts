import { test, expect } from '@playwright/test';
import { dropTerrainAccessUtmLas, openAnalysePanel } from './helpers';
import { MAX_GAP_MS, settled, stopWatching, watch } from './mainThreadWatch';

/**
 * A terrain run that waits on its worker shows how long it has been running,
 * beside the busy indicator and in the state strip, and the page stays
 * responsive meanwhile. The heartbeat and its bound are in `mainThreadWatch.ts`.
 */

test('a terrain run that waits on its worker shows the elapsed time beside the indicator and in the state strip', async ({ page, context }) => {
  // Hold the terrain worker's script for 5 s: the run then waits a known
  // time with the page idle, on any engine and any machine.
  await context.route(/terrainCoreWorker-[^/]*\.js$/, async (route) => {
    await new Promise((r) => setTimeout(r, 5000));
    await route.continue();
  });
  await page.goto('/?test=1');
  await dropTerrainAccessUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ })).toBeEnabled({ timeout: 20_000 });
  await openAnalysePanel(page);
  await watch(page);

  await page.locator('.olv-analyse-run').click();
  const wait = page.locator('.olv-analyse-status .olv-busy-wait');
  await expect(wait).toHaveText(/^\d+ s elapsed$/, { timeout: 10_000 });
  await expect(wait).toHaveAttribute('aria-hidden', 'true');
  await expect(settled(page)).toHaveCount(3, { timeout: 30_000 });
  await expect(page.locator('.olv-busy-wait')).toHaveCount(0);

  const { gap, waits } = await stopWatching(page);
  expect(gap, `longest main-thread gap during the run: ${Math.round(gap)} ms`).toBeLessThan(MAX_GAP_MS);
  expect(waits.some((t) => t.includes('olv-ss-processing|Analysing') && /· \d+ s elapsed$/.test(t)), JSON.stringify(waits)).toBe(true);
});
