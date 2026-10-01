import { test, expect } from '@playwright/test';
import { EPT_FIXTURE_NODES, openEptFixture, routeEptFixture } from './streamingFixtures';

/**
 * A task that reports progress shows an estimate of the time left.
 *
 * The EPT fixture streams a root and four child tiles. Each child is held
 * back so one arrives every 2.5 s: the opening line's progress trail then
 * climbs in steps, the time left can be estimated, and the page is open the
 * whole time. Every text the page shows is recorded and checked: the estimate
 * appears, beside the indicator and in the strip, and never reads NaN,
 * Infinity or a negative number.
 */

const STEP_MS = 2500;

test('a streaming open that reports progress shows the time left', async ({ page }) => {
  test.slow();
  await routeEptFixture(page);
  let next = 0;
  await page.route('**/ept-data/1-*', async (route) => {
    const k = ++next;
    await new Promise((r) => setTimeout(r, k * STEP_MS));
    await route.fallback();
  });
  await page.goto('/?test=1');
  await page.evaluate(() => {
    const w = window as unknown as { __waits: string[] };
    w.__waits = [];
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('.olv-busy-wait, .olv-ss-processing')) {
        const t = `${node.className}|${node.textContent ?? ''}`;
        if (/elapsed/.test(t) && !w.__waits.includes(t)) w.__waits.push(t);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await openEptFixture(page);
  await expect(page.locator('.olv-busy-wait').filter({ hasText: /left$/ }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.olv-ss-processing .olv-ss-wait')).toHaveText(/elapsed, (about \d+ (s|min) left|a few seconds left)$/);
  await expect.poll(() => next, { timeout: 30_000 }).toBe(EPT_FIXTURE_NODES - 1);
  await expect(page.locator('.olv-busy-wait')).toHaveCount(0, { timeout: 30_000 });

  const waits = await page.evaluate(() => (window as unknown as { __waits: string[] }).__waits);
  expect(waits.some((t) => / left$/.test(t)), JSON.stringify(waits)).toBe(true);
  for (const t of waits) {
    expect(t, 'a wait text').not.toMatch(/NaN|Infinity|-\d/);
    expect(t, 'a wait text').toMatch(/\d+ s elapsed|\d+ min \d+ s elapsed/);
  }
});
