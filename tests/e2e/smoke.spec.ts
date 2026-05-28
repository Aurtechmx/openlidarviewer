import { test, expect } from '@playwright/test';

/**
 * Startup smoke tests — the blocking gate.
 *
 * These two specs are the structural complement to the unit + typecheck +
 * build gates: they catch the class of bug where the module loads cleanly
 * in Node and the bundle builds cleanly, but the actual page throws on
 * load in a real browser. Kept deliberately small and fast so the gate
 * stays cheap.
 *
 * If either of these fails, do not ship.
 */

test.describe('startup smoke', () => {
  test('the empty state renders without console errors or page errors', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(`${err.message}\n${err.stack ?? ''}`);
    });

    await page.goto('/');
    // The empty state must render even before the lazy Viewer chunk has
    // loaded — it is the user's first frame.
    await expect(page.locator('.olv-empty')).toBeVisible();
    await expect(page.locator('.olv-empty-title')).toBeVisible();

    // Give the lazy Viewer chunk + GPU backend init time to settle. Any
    // throw from the deferred wiring would surface as a pageerror here.
    await page.waitForTimeout(3000);

    expect(
      pageErrors,
      `Unexpected pageerror events during startup:\n${pageErrors.join('\n---\n')}`,
    ).toEqual([]);
    expect(
      consoleErrors,
      `Unexpected console.error events during startup:\n${consoleErrors.join('\n---\n')}`,
    ).toEqual([]);
  });

  test('?debug=1 mounts the overlay without errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(`${err.message}\n${err.stack ?? ''}`);
    });

    await page.goto('/?debug=1');
    // The debug overlay is mounted by a lazy chunk; give it the full
    // 5 s budget the live test uses.
    await expect(page.locator('.olv-debug')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.olv-empty')).toBeVisible();

    expect(
      pageErrors,
      `Unexpected pageerror events with ?debug=1:\n${pageErrors.join('\n---\n')}`,
    ).toEqual([]);
    expect(
      consoleErrors,
      `Unexpected console.error events with ?debug=1:\n${consoleErrors.join('\n---\n')}`,
    ).toEqual([]);
  });
});
