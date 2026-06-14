import { test, expect, type Page } from '@playwright/test';

/**
 * v0.4.6 header full-screen toggle.
 *
 * The toggle drives the browser Fullscreen API on the whole app and swaps its
 * enter/exit glyph from the `fullscreenchange` event (so F11 / Esc are
 * reflected too). Headless Chromium routinely refuses a real fullscreen
 * request, and `fullscreenchange` may never fire there — so this spec pins the
 * integration surface that CAN be asserted deterministically: the control is
 * mounted in the header with its accessibility contract, and activating it
 * never throws. It does NOT assert the viewport actually entered fullscreen.
 */

async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForTimeout(300);
}

test.describe('full-screen toggle — header', () => {
  test('mounts in the top bar with its aria contract', async ({ page }) => {
    await gotoApp(page);
    const fs = page.locator('.olv-topbar-right .olv-fs-toggle');
    await expect(fs).toBeVisible();
    await expect(fs).toHaveAttribute('aria-pressed', 'false');
    await expect(fs).toHaveAttribute('aria-label', /full screen/i);
    // The glyph is an inline SVG (the enter "expand to corners" mark).
    await expect(fs.locator('svg')).toHaveCount(1);
  });

  test('activating it never raises a page error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await gotoApp(page);
    const fs = page.locator('.olv-topbar-right .olv-fs-toggle');
    // A trusted click. Whether the browser grants fullscreen or rejects it,
    // the handler swallows the rejection — neither path may throw.
    await fs.click();
    await page.waitForTimeout(200);
    // If fullscreen was granted, exit again so the run leaves no lingering
    // fullscreen state; tolerate a rejection (headless) silently.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(100);

    expect(errors).toEqual([]);
  });
});
