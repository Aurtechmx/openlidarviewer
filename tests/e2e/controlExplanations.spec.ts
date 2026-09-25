/**
 * Every interactive control explains itself on hover and on keyboard focus
 * (the maintainer requirement behind lint:control-explanations). Two
 * mechanisms carry this: the native `title` attribute (toolbar, most panel
 * buttons) and the shared `[data-tip]` glass tooltip. The visible tip for the
 * latter is rendered by ONE top-level layer (src/ui/tipLayer.ts), appended to
 * `document.body` and positioned from the hovered/focused control's own
 * `getBoundingClientRect()` — not a per-control `::after` pseudo-element,
 * which broke for any control in a lower stacking context than a sibling
 * panel (a live check found the header theme toggle's tip clipped/covered
 * under `.olv-right-rail`, z-index: 15, no matter what z-index the
 * pseudo-element itself carried). The control still wires an
 * `aria-describedby` text node (src/ui/dom.ts), unchanged by that move. This
 * spec exercises one representative control from each mechanism, plus a
 * color-by chip once a scan is loaded, rather than re-testing every control
 * the unit-level lint already guards.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { suppressOnboardingTour, dropTinyLas } from './helpers';

const FIXTURE = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));

test.describe('control explanations', () => {
  test('the theme toggle (data-tip) explains itself on hover, on focus, and hides on Escape', async ({ page }) => {
    // Without this, the onboarding tour's full-screen overlay can pop over
    // the toggle mid-test and steal :hover from underneath it (real cursor
    // position is over the overlay's topmost box, not the button beneath).
    await suppressOnboardingTour(page);
    await page.goto('/');
    const toggle = page.locator('.olv-theme-toggle');
    await expect(toggle).toBeVisible();

    const tip = await toggle.getAttribute('data-tip');
    expect(tip, 'the toggle carries a data-tip explanation').toBeTruthy();
    const describedBy = await toggle.getAttribute('aria-describedby');
    expect(describedBy, 'the toggle points assistive tech at a description').toBeTruthy();
    const desc = page.locator(`#${describedBy}`);
    await expect(desc).toHaveText(tip ?? '');

    const tipLayer = page.locator('.olv-tip-layer');

    // Hover shows the floating tip layer, with the same text as the hidden
    // description. Layout can still be settling right after a fresh load
    // (banner/icon transitions), which can nudge the toggle out from under
    // the cursor a moment after the first `hover()` — re-issuing it inside
    // the retry loop recovers instead of failing on that one race.
    await expect(async () => {
      await toggle.hover();
      await expect(tipLayer).toHaveClass(/olv-tip-layer--visible/);
    }).toPass();
    await expect(tipLayer).toHaveText(tip ?? '');

    // Move away, then reach the same control by keyboard only.
    await page.mouse.move(0, 0);
    await toggle.focus();
    await expect(tipLayer).toHaveClass(/olv-tip-layer--visible/);

    // Escape dismisses it without moving focus away.
    await page.keyboard.press('Escape');
    await expect(tipLayer).not.toHaveClass(/olv-tip-layer--visible/);
  });

  test('a header control next to the right rail shows its tip fully inside the viewport, on desktop and at 320px', async ({ page }) => {
    test.slow();
    await suppressOnboardingTour(page);
    await page.goto('/');
    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    // The right rail (Scan Intelligence / Streaming) only mounts once a scan
    // is loaded — the theme toggle sits in the header right next to it,
    // which is exactly the control the live check found clipped.
    await expect(page.locator('.olv-right-rail')).toBeVisible();

    const toggle = page.locator('.olv-theme-toggle');
    const tipLayer = page.locator('.olv-tip-layer');

    for (const viewport of [{ width: 1280, height: 860 }, { width: 320, height: 700 }]) {
      await page.setViewportSize(viewport);
      await page.mouse.move(0, 0);
      await expect(async () => {
        await toggle.hover();
        await expect(tipLayer).toHaveClass(/olv-tip-layer--visible/);
      }).toPass();

      const box = await tipLayer.boundingBox();
      expect(box, `tip has a bounding box at ${viewport.width}px`).toBeTruthy();
      if (!box) continue;
      expect(box.x, `tip left edge inside the ${viewport.width}px viewport`).toBeGreaterThanOrEqual(0);
      expect(box.y, `tip top edge inside the ${viewport.width}px viewport`).toBeGreaterThanOrEqual(0);
      expect(
        box.x + box.width,
        `tip right edge inside the ${viewport.width}px viewport`,
      ).toBeLessThanOrEqual(viewport.width);
      expect(
        box.y + box.height,
        `tip bottom edge inside the ${viewport.width}px viewport`,
      ).toBeLessThanOrEqual(viewport.height);

      // The tip layer must actually be the topmost paint at its own center —
      // not a panel sitting above it in a different stacking context, which
      // is exactly the bug this whole mechanism replaced.
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      const topmostIsTip = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest('.olv-tip-layer') != null,
        [centerX, centerY] as const,
      );
      expect(topmostIsTip, `the tip layer paints on top at ${viewport.width}px, not a panel`).toBe(true);

      await page.keyboard.press('Escape');
      await expect(tipLayer).not.toHaveClass(/olv-tip-layer--visible/);
    }
  });

  test('the toolbar and a color-mode chip explain themselves via the native title attribute, once a scan is loaded', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await page.locator('.olv-file-input').first().setInputFiles(FIXTURE);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 60_000 });

    const frame = page.getByRole('button', { name: /^Frame$/ });
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('title', /./);

    const heightChip = page.locator('.olv-chip', { hasText: 'Height' }).first();
    await expect(heightChip).toBeVisible();
    await expect(heightChip).toHaveAttribute('title', /./);
  });

  test('a title-only control gets the styled tip on hover without a native double, and on keyboard focus', async ({ page }) => {
    test.slow();
    await suppressOnboardingTour(page);
    await page.goto('/');
    await page.locator('.olv-file-input').first().setInputFiles(FIXTURE);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 60_000 });

    const frame = page.getByRole('button', { name: /^Frame$/ });
    await expect(frame).toBeVisible();
    const title = await frame.getAttribute('title');
    expect(title, 'Frame carries a native title').toBeTruthy();
    expect(await frame.getAttribute('data-tip'), 'Frame has no data-tip of its own').toBeNull();

    const tipLayer = page.locator('.olv-tip-layer');
    await expect(async () => {
      await frame.hover();
      await expect(tipLayer).toHaveClass(/olv-tip-layer--visible/);
    }).toPass();
    await expect(tipLayer).toHaveText(title ?? '');
    // Lifted while the styled tip shows, so the browser's own tooltip can't double it.
    await expect(frame).not.toHaveAttribute('title', /./);

    await page.mouse.move(0, 0);
    await expect(tipLayer).not.toHaveClass(/olv-tip-layer--visible/);
    await expect(frame).toHaveAttribute('title', title ?? '');

    await frame.focus();
    await expect(tipLayer).toHaveClass(/olv-tip-layer--visible/);
    await expect(tipLayer).toHaveText(title ?? '');
    await expect(frame).toHaveAttribute('title', title ?? '');
  });

  test('the header Guide link explains itself with a styled tip', async ({ page }) => {
    await suppressOnboardingTour(page);
    await page.goto('/');
    const guide = page.locator('a.olv-github', { hasText: 'Guide' });
    await expect(guide).toHaveAttribute('data-tip', /./);
    const tipLayer = page.locator('.olv-tip-layer');
    await expect(async () => {
      await guide.hover();
      await expect(tipLayer).toHaveClass(/olv-tip-layer--visible/);
    }).toPass();
    await expect(tipLayer).toHaveText((await guide.getAttribute('data-tip')) ?? '');
  });
});
