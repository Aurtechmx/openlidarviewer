import { test, expect } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * v0.4.4 a11y announcement pins + the I-key collision canary.
 *
 * Two toast surfaces are the app's only feedback channel for several
 * flows (load progress, rejected opens, tool hints), so they must be
 * screen-reader live regions:
 *   - the DropZone (src/ui/DropZone.ts) announces through two PERMANENTLY
 *     rendered visually-hidden live regions (role="status" for progress,
 *     role="alert" for errors) — NOT through the visible `.olv-toast`,
 *     which hides via display:none and would silence a live region;
 *   - the lasso toast (`.olv-lasso-toast`, src/main.ts showLassoToast)
 *     is created with role="status" aria-live="polite".
 *
 * These are cheap attribute pins: the elements may be hidden, so we
 * assert attributes, never visibility, except where a keypress makes
 * the toast show.
 *
 * The last test is the regression canary for the v0.4.3 `I` collision:
 * bare `I` now belongs solely to the Inspect tool (src/ui/shortcuts.ts
 * → onInspect); the Iso camera preset no longer binds it
 * (CAMERA_PRESET_KEY.iso === ''). Toggling Inspect twice must be clean —
 * no console/page errors and no camera toast.
 */

test.describe('a11y announcements', () => {
  test('the DropZone announces through always-rendered live regions', async ({
    page,
  }) => {
    await page.goto('/');
    // The status / alert nodes are mounted (visually hidden, never
    // display:none) at boot — DropZone appends them to the drop target.
    const status = page.locator('.olv-visually-hidden[role="status"]');
    await expect(status).toHaveCount(1);
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('.olv-visually-hidden[role="alert"]')).toHaveCount(1);
    // The visible toast itself is presentation-only now — carrying a
    // live-region role on a display:none-toggled element announced
    // unreliably (the original bug this layout fixes).
    const toast = page.locator('.olv-toast');
    await expect(toast).toHaveCount(1);
    expect(await toast.getAttribute('role')).toBeNull();
    expect(await toast.getAttribute('aria-live')).toBeNull();
    await expect(toast).toHaveClass(/olv-hidden/);
  });

  test('the lasso toast is a polite status live region', async ({ page }) => {
    await page.goto('/');
    // The toast element is created lazily on first use — pressing L arms
    // the lasso volume tool and shows a hint toast even in the empty
    // state (main.ts window keydown handler → showLassoToast).
    await page.keyboard.press('l');
    const toast = page.locator('.olv-lasso-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('role', 'status');
    await expect(toast).toHaveAttribute('aria-live', 'polite');
  });

  test('pressing I twice toggles Inspect cleanly — no errors, no camera toast', async ({
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
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(800);
    // Click anywhere outside form inputs so keyboard events land on body.
    await page.locator('.olv-stage').click({ position: { x: 1, y: 1 } });

    await page.keyboard.press('i');
    await page.waitForTimeout(200);
    await page.keyboard.press('i');
    await page.waitForTimeout(200);

    // The v0.4.3 collision fired the Iso camera preset on the same press;
    // pinned out — no `Camera · …` toast may appear for I. The toast
    // element is mounted lazily (showLassoToast creates it on first
    // use), so a negative text matcher against the bare locator would
    // be asserting about an element that may not exist. Assert the
    // count instead: either the toast was never mounted at all, or it
    // exists but carries no camera-preset text.
    await expect(
      page.locator('.olv-lasso-toast', { hasText: 'Camera ·' }),
    ).toHaveCount(0);
    expect(
      pageErrors,
      `Unexpected pageerror events while toggling Inspect:\n${pageErrors.join('\n---\n')}`,
    ).toEqual([]);
    expect(
      consoleErrors,
      `Unexpected console.error events while toggling Inspect:\n${consoleErrors.join('\n---\n')}`,
    ).toEqual([]);
  });
});
