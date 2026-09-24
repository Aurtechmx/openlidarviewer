/**
 * Every interactive control explains itself on hover and on keyboard focus
 * (the maintainer requirement behind lint:control-explanations). Two
 * mechanisms carry this: the native `title` attribute (toolbar, most panel
 * buttons) and the shared `[data-tip]` glass tooltip wired in src/ui/dom.ts
 * (an `aria-describedby` text node, shown on `:hover` / `:focus-visible`,
 * dismissed on Escape). This spec exercises one representative control from
 * each mechanism, plus a color-by chip once a scan is loaded, rather than
 * re-testing every control the unit-level lint already guards.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));

test.describe('control explanations', () => {
  test('the theme toggle (data-tip) explains itself on hover, on focus, and hides on Escape', async ({ page }) => {
    await page.goto('/');
    const toggle = page.locator('.olv-theme-toggle');
    await expect(toggle).toBeVisible();

    const tip = await toggle.getAttribute('data-tip');
    expect(tip, 'the toggle carries a data-tip explanation').toBeTruthy();
    const describedBy = await toggle.getAttribute('aria-describedby');
    expect(describedBy, 'the toggle points assistive tech at a description').toBeTruthy();
    const desc = page.locator(`#${describedBy}`);
    await expect(desc).toHaveText(tip ?? '');

    // Hover shows the CSS tooltip (::after, content: attr(data-tip)).
    await toggle.hover();
    await expect(async () => {
      const opacity = await toggle.evaluate((el) => getComputedStyle(el, '::after').opacity);
      expect(opacity).toBe('1');
    }).toPass();

    // Move away, then reach the same control by keyboard only.
    await page.mouse.move(0, 0);
    await toggle.focus();
    await expect(async () => {
      const opacity = await toggle.evaluate((el) => getComputedStyle(el, '::after').opacity);
      expect(opacity).toBe('1');
    }).toPass();

    // Escape dismisses it without moving focus away.
    await page.keyboard.press('Escape');
    await expect(async () => {
      const opacity = await toggle.evaluate((el) => getComputedStyle(el, '::after').opacity);
      expect(opacity).toBe('0');
    }).toPass();
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
});
