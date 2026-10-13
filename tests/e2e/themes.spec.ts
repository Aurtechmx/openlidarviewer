import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, reloadSettled, showWorkspaceMode } from './helpers';

/**
 * Interface themes — Blue, Field and High contrast.
 *
 * The registry is covered by themes.test.ts and the control by
 * themeToggle.test.ts; the palettes' token ratios by fieldPalette.test.ts and
 * themeHighContrast.test.ts. This spec checks the wiring in a real page: Blue
 * is the default, the header toggle cycles Blue → Field → High contrast → Blue
 * with the matching body class and keeps keyboard focus, the choice survives a
 * reload, a saved Light choice opens Field, the layout does not overflow at
 * phone, tablet and desktop widths, and forced colours still take over.
 *
 * Set OLV_THEME_SHOTS to a directory to also save a loaded-cloud screenshot of
 * each palette there.
 */

const SHOTS = process.env.OLV_THEME_SHOTS;
const THEME_CLASSES = ['olv-theme-field', 'olv-theme-high-contrast', 'olv-theme-light'];

/** The theme classes currently on <body>. */
async function themeClasses(page: Page): Promise<string[]> {
  return page.evaluate((all) => all.filter((c) => document.body.classList.contains(c)), THEME_CLASSES);
}

/** The lit icon's `data-theme`. */
async function activeIcon(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('.olv-theme-icon-active')?.getAttribute('data-theme') ?? null);
}

/** A body-level token's computed value. */
async function bodyToken(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => getComputedStyle(document.body).getPropertyValue(n).trim(), name);
}

/** Seed a saved theme before the first boot only, so a reload reads what the app wrote. */
async function seedSavedTheme(page: Page, value: string): Promise<void> {
  await page.addInitScript((v) => {
    if (sessionStorage.getItem('olv-test-theme-seeded')) return;
    localStorage.setItem('olv-theme', v);
    sessionStorage.setItem('olv-test-theme-seeded', '1');
  }, value);
}

test.describe('interface themes', () => {
  test('Blue is the default with no theme class and its original tokens', async ({ page }) => {
    await page.goto('/');
    const toggle = page.locator('.olv-theme-toggle');
    await expect(toggle).toHaveAttribute('aria-label', 'Theme: Blue — switch to Field');
    expect(await themeClasses(page)).toEqual([]);
    expect(await activeIcon(page)).toBe('dark');
    expect(await bodyToken(page, '--bg')).toBe('#030817');
    expect(await bodyToken(page, '--accent')).toBe('#00b2ff');
  });

  test('the keyboard cycles Blue → Field → High contrast → Blue and keeps focus', async ({ page }) => {
    await page.goto('/');
    const toggle = page.locator('.olv-theme-toggle');
    await toggle.focus();

    await page.keyboard.press('Enter');
    await expect(page.locator('body')).toHaveClass(/olv-theme-field/);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-label', 'Theme: Field — switch to High contrast');
    expect(await themeClasses(page)).toEqual(['olv-theme-field']);
    expect(await bodyToken(page, '--panel')).toBe('#262e30');

    await page.keyboard.press('Space');
    await expect(page.locator('body')).toHaveClass(/olv-theme-high-contrast/);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-label', 'Theme: High contrast — switch to Blue');
    expect(await themeClasses(page)).toEqual(['olv-theme-high-contrast']);
    expect(await activeIcon(page)).toBe('high-contrast');
    // The build may shorten the hex.
    expect(await bodyToken(page, '--bg')).toMatch(/^#000(000)?$/);
    // The focused toggle shows the thick high-visibility ring.
    const ring = await toggle.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: parseFloat(cs.outlineWidth), style: cs.outlineStyle };
    });
    expect(ring.style).toBe('solid');
    expect(ring.width).toBeGreaterThanOrEqual(3);

    await page.keyboard.press('Enter');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-label', 'Theme: Blue — switch to Field');
    expect(await themeClasses(page)).toEqual([]);
    expect(await bodyToken(page, '--bg')).toBe('#030817');
  });

  test('the command palette lists exactly the three themes', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('theme');
    const rows = page.locator('.olv-palette-row-title', { hasText: / theme$/ });
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Blue theme');
    await expect(rows.nth(1)).toContainText('Field theme');
    await expect(rows.nth(2)).toContainText('High contrast theme');
    await expect(page.locator('.olv-palette-row-title', { hasText: 'Light theme' })).toHaveCount(0);
  });

  for (const theme of ['field', 'high-contrast'] as const) {
    test(`a reload restores ${theme}`, async ({ page }) => {
      await page.goto('/');
      const toggle = page.locator('.olv-theme-toggle');
      await toggle.click();
      if (theme === 'high-contrast') await toggle.click();
      await expect(page.locator('body')).toHaveClass(new RegExp(`olv-theme-${theme}`));
      await reloadSettled(page);
      await expect(page.locator('body')).toHaveClass(new RegExp(`olv-theme-${theme}`));
      expect(await activeIcon(page)).toBe(theme);
      expect(await page.evaluate(() => localStorage.getItem('olv-theme'))).toBe(theme);
    });
  }

  test('a saved Light choice opens Field and is rewritten', async ({ page }) => {
    await seedSavedTheme(page, 'light');
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/olv-theme-field/);
    expect(await themeClasses(page)).toEqual(['olv-theme-field']);
    expect(await page.evaluate(() => localStorage.getItem('olv-theme'))).toBe('field');
    await reloadSettled(page);
    await expect(page.locator('.olv-theme-toggle')).toHaveAttribute('aria-label', /^Theme: Field/);
  });

  test('a saved High contrast choice stays High contrast', async ({ page }) => {
    await seedSavedTheme(page, 'high-contrast');
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/olv-theme-high-contrast/);
    expect(await page.evaluate(() => localStorage.getItem('olv-theme'))).toBe('high-contrast');
  });

  test('a malformed saved value falls back to Blue', async ({ page }) => {
    await seedSavedTheme(page, 'midnight');
    await page.goto('/');
    await expect(page.locator('.olv-theme-toggle')).toHaveAttribute('aria-label', /^Theme: Blue/);
    expect(await themeClasses(page)).toEqual([]);
  });

  for (const width of [390, 768, 1280]) {
    test(`no page overflow at ${width} px in any theme`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const toggle = page.locator('.olv-theme-toggle');
      for (let i = 0; i < 3; i++) {
        const overflow = await page.evaluate(() => ({
          x: document.documentElement.scrollWidth - innerWidth,
          y: document.documentElement.scrollHeight - innerHeight,
        }));
        expect(overflow.x, `horizontal overflow, step ${i}`).toBeLessThanOrEqual(0);
        expect(overflow.y, `vertical overflow, step ${i}`).toBeLessThanOrEqual(0);
        await expect(toggle).toBeVisible();
        await toggle.click();
      }
    });
  }

  test('forced colours still take over in High contrast', async ({ page }) => {
    await page.goto('/');
    const toggle = page.locator('.olv-theme-toggle');
    await toggle.click();
    await toggle.click();
    await expect(page.locator('body')).toHaveClass(/olv-theme-high-contrast/);
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await expect(toggle).toBeVisible();
    // The palette's own component rules step aside: no forced 2px edge.
    expect(await page.evaluate(() => matchMedia('(forced-colors: none)').matches)).toBe(false);
    await toggle.click();
    await expect(page.locator('body')).not.toHaveClass(/olv-theme-/);
  });

  test('switching palettes with a cloud loaded keeps the data and reaches every palette', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
    await showWorkspaceMode(page, 'data');
    await expect(page.locator('.olv-inspector, .olv-left-panels').first()).toBeVisible();
    const toggle = page.locator('.olv-theme-toggle');
    for (const theme of ['dark', 'field', 'high-contrast'] as const) {
      expect(await activeIcon(page)).toBe(theme);
      await expect(page.locator('.olv-empty')).toBeHidden();
      if (SHOTS) {
        await page.mouse.move(1, 1);
        await page.screenshot({ path: `${SHOTS}/theme-${theme}-loaded.png`, animations: 'disabled' });
      }
      await toggle.click();
    }
    expect(await activeIcon(page)).toBe('dark');
  });
});
