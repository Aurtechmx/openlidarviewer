import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly, railChromeSettled } from './helpers';

/**
 * tests/e2e/inspectorDetailMode.spec.ts
 *
 * The View Inspector's Basic / Advanced detail switch. Basic is the default
 * for a new user and hides the technician sections; Advanced shows them all.
 * The layout checks run at the four reference viewports in both themes: the
 * switch stays inside the panel, nothing scrolls sideways, and the mode
 * survives a reload. Set OLV_SHOTS_DIR to also write a screenshot of each
 * state for visual review.
 */

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, phone: false },
  { name: 'laptop', width: 1280, height: 720, phone: false },
  { name: 'tablet', width: 820, height: 1180, phone: false },
  { name: 'phone', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['dark', 'light'] as const;
const SHOTS = process.env.OLV_SHOTS_DIR ?? '';
const SWITCH = '.olv-inspector .olv-detail-mode';

async function openScan(page: Page, theme: string, phone: boolean): Promise<void> {
  await page.addInitScript((t: string) => {
    try {
      localStorage.setItem('olv:tour:v1:completed', '1');
      localStorage.setItem('olv-theme', t);
    } catch {
      // Storage blocked: the page runs with its defaults.
    }
  }, theme);
  await page.goto('/?test=1');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  if (phone) {
    await expect(page.locator('.olv-mobile-sheet')).toBeVisible({ timeout: 8_000 });
    await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="view"]').click();
  }
  await railChromeSettled(page);
  // A narrow desktop starts with the right rail folded; open it.
  const tab = page.locator('.olv-right-rail-tab[aria-controls="olv-right-rail"]');
  if (!phone && (await tab.getAttribute('aria-expanded')) === 'false') {
    await tab.click();
    await railChromeSettled(page);
  }
  await expect(page.locator('.olv-inspector').first()).toBeVisible();
}

async function shot(page: Page, file: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, file) });
}

/** True when no element inside the Inspector is wider than the panel itself. */
async function noSidewaysOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const panel = document.querySelector('.olv-inspector');
    if (!panel) return false;
    return panel.scrollWidth <= panel.clientWidth + 1;
  });
}

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`Inspector Basic / Advanced layout — ${vp.name} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openScan(page, theme, vp.phone);
      const tag = `${vp.name}-${vp.width}x${vp.height}-${theme}`;
      const toggle = page.locator(SWITCH);
      if ((await toggle.count()) === 0) {
        // Before the switch existed: record the panel for comparison only.
        await shot(page, `before-${tag}.png`);
        test.skip(true, 'no detail switch on this build');
        return;
      }

      const basic = toggle.getByRole('button', { name: 'Basic' });
      const advanced = toggle.getByRole('button', { name: 'Advanced' });
      await expect(basic).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.olv-inspector summary', { hasText: 'Provenance' })).toBeHidden();
      await expect(page.locator('.olv-inspector summary', { hasText: 'Saved views' })).toBeVisible();

      // The switch sits inside the panel, on one line.
      const panelBox = (await page.locator('.olv-inspector').boundingBox())!;
      const switchBox = (await toggle.boundingBox())!;
      expect(switchBox.x).toBeGreaterThanOrEqual(panelBox.x - 1);
      expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
      const basicBox = (await basic.boundingBox())!;
      const advBox = (await advanced.boundingBox())!;
      expect(Math.abs(basicBox.y - advBox.y)).toBeLessThan(2);
      expect(await noSidewaysOverflow(page)).toBe(true);
      await shot(page, `after-${tag}-basic.png`);

      await advanced.click();
      await expect(advanced).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.olv-inspector summary', { hasText: 'Provenance' })).toBeVisible();
      await expect(page.locator('.olv-inspector summary', { hasText: 'Scan report' })).toBeVisible();
      expect(await noSidewaysOverflow(page)).toBe(true);
      await shot(page, `after-${tag}-advanced.png`);

      // The choice is a UI preference and survives a reload.
      if (!vp.phone && theme === 'dark') {
        await page.reload();
        await dropTinyPly(page);
        await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
        await expect(page.locator(SWITCH).getByRole('button', { name: 'Advanced' })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
      }
    });
  }
}
