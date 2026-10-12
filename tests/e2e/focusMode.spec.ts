import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyPly, firePaletteAction, placeTestDistance, openToolPage } from './helpers';

/**
 * tests/e2e/focusMode.spec.ts
 *
 * Focus mode (src/app/workspace/focusMode.ts) in the live layout: the control
 * collapses both rails without writing their stored preference, Esc and the
 * control bring back exactly what was there, the scan's clear area grows, and
 * phones are not offered the control. Screenshots go to OLV_FOCUS_SHOTS when
 * it is set, for a person to look at; nothing is asserted on pixels.
 */

const TOGGLE = '.olv-focus-toggle';
const LEFT = '.olv-left-panels';
const RIGHT = '.olv-right-rail';
const SHOTS = process.env.OLV_FOCUS_SHOTS ?? '';

async function loadScan(page: Page, theme = 'dark', url = '/'): Promise<void> {
  await suppressOnboardingTour(page);
  await page.addInitScript((t) => { try { localStorage.setItem('olv-theme', t); } catch { /* blocked storage */ } }, theme);
  await page.goto(url);
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(600);
}

/**
 * The scan's unobstructed area: the canvas minus every opaque chrome box that
 * Focus mode is responsible for (rails, their grabbers, the visible header
 * controls, the renderer chip). Sampled on a 4 px grid so overlaps count once.
 */
async function clearArea(page: Page): Promise<{ canvas: number; clear: number; band: number }> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas')!.getBoundingClientRect();
    const sel = '.olv-left-panels, .olv-right-rail, .olv-rail-tab, .olv-right-rail-tab, .olv-backend, .olv-wordmark, .olv-topbar-right > *';
    const boxes = Array.from(document.querySelectorAll<HTMLElement>(sel))
      .filter((n) => {
        const s = getComputedStyle(n);
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
      })
      .map((n) => n.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    const step = 4;
    let covered = 0;
    for (let y = c.top; y < c.bottom; y += step) {
      for (let x = c.left; x < c.right; x += step) {
        if (boxes.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) covered += 1;
      }
    }
    // The clear horizontal band at mid height, between whatever rails remain.
    const mid = c.top + c.height / 2;
    let leftEdge = c.left;
    let rightEdge = c.right;
    for (const r of boxes) {
      if (mid < r.top || mid >= r.bottom) continue;
      if (r.right <= c.left + c.width / 2) leftEdge = Math.max(leftEdge, r.right);
      else rightEdge = Math.min(rightEdge, r.left);
    }
    const canvas = Math.round(c.width * c.height);
    return { canvas, clear: Math.round(canvas - covered * step * step), band: Math.round(rightEdge - leftEdge) };
  });
}

const prefs = (page: Page): Promise<[string | null, string | null]> =>
  page.evaluate(() => [localStorage.getItem('olv.leftRail.collapsed'), localStorage.getItem('olv.rightRail.inspector.collapsed')]);

const DESKTOP = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 820, height: 1180 },
];

for (const viewport of DESKTOP) {
  for (const theme of ['dark', 'light']) {
    test(`focus grows the clear stage at ${viewport.width}x${viewport.height} (${theme})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await loadScan(page, theme);
      // Start from both rails open, so the gain is the whole of Focus mode's.
      await page.evaluate(() => {
        for (const sel of ['.olv-rail-tab', '.olv-right-rail-tab']) {
          const t = document.querySelector<HTMLButtonElement>(sel);
          if (t?.getAttribute('aria-expanded') === 'false') t.click();
        }
      });
      await page.waitForTimeout(1200); // past the theme and rail transitions
      const before = await clearArea(page);
      const prefsBefore = await prefs(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${viewport.width}x${viewport.height}-${theme}-off.png` });

      await page.locator(TOGGLE).click();
      await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.move(viewport.width / 2, viewport.height / 2); // no hover tip in the shot
      await page.waitForTimeout(800);
      const after = await clearArea(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${viewport.width}x${viewport.height}-${theme}-on.png` });
      console.log(`[focus-area] ${viewport.width}x${viewport.height} ${theme} canvas=${before.canvas} clearOff=${before.clear} clearOn=${after.clear} gain=${after.clear - before.clear} (${(((after.clear - before.clear) / before.clear) * 100).toFixed(1)}%) bandOff=${before.band} bandOn=${after.band}`);

      expect(after.clear).toBeGreaterThan(before.clear * 1.15);
      expect(after.band).toBeGreaterThan(before.band);
      // The orbit/walk/fly/pan card, the dock and the state strip stay.
      await expect(page.locator('.olv-navbar')).toBeVisible();
      await expect(page.locator('.olv-dock')).toBeVisible();
      // Nothing written to the stored rail preference.
      expect(await prefs(page)).toEqual(prefsBefore);

      await page.locator(TOGGLE).click();
      await expect(page.locator(LEFT)).not.toHaveClass(/olv-rail-collapsed/);
      await expect(page.locator(RIGHT)).not.toHaveClass(/olv-right-collapsed/);
      expect(await prefs(page)).toEqual(prefsBefore);
    });
  }
}

test('Esc exits Focus mode, but an open palette takes Esc first', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadScan(page);
  await page.locator(TOGGLE).click();
  await expect(page.locator(LEFT)).toHaveClass(/olv-rail-collapsed/);

  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.olv-palette')).toBeHidden();
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');

  await page.locator('canvas').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press('Escape');
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(LEFT)).not.toHaveClass(/olv-rail-collapsed/);
});

test('the palette action toggles, a pre-collapsed rail stays collapsed, the route survives', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadScan(page);
  await page.locator('.olv-rail-tab').click(); // the user's own choice
  await expect(page.locator(LEFT)).toHaveClass(/olv-rail-collapsed/);
  const prefsBefore = await prefs(page);
  const tabBefore = await page.locator('.olv-ws-tab[aria-selected="true"]').getAttribute('data-mode');

  await firePaletteAction(page, 'focus mode', 'Focus Mode');
  await expect(page.locator(RIGHT)).toHaveClass(/olv-right-collapsed/);
  await firePaletteAction(page, 'focus mode', 'Focus Mode');
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'false');

  await expect(page.locator(LEFT)).toHaveClass(/olv-rail-collapsed/);
  await expect(page.locator(RIGHT)).not.toHaveClass(/olv-right-collapsed/);
  expect(await page.locator('.olv-ws-tab[aria-selected="true"]').getAttribute('data-mode')).toBe(tabBefore);
  expect(await prefs(page)).toEqual(prefsBefore);
});

test('measurements and the measure guidance stay; the tool takes Esc first; keyboard toggles', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await loadScan(page, 'dark', '/?test=1');
  await openToolPage(page, 'Measure');
  await placeTestDistance(page);
  const guidance = page.locator('.olv-measure-bar');
  const guided = await guidance.isVisible();
  await page.locator(TOGGLE).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.olv-mp-row')).toHaveCount(1);
  if (guided) await expect(guidance).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1280x720-dark-on-measuring.png` });
  // Measuring owns Escape: it ends the tool, and Focus mode stays.
  if (guided) {
    await page.keyboard.press('Escape');
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');
  }
  await page.locator(TOGGLE).focus();
  await page.keyboard.press('Space');
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.olv-mp-row')).toHaveCount(1);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  for (const theme of ['dark', 'light']) {
    test(`phones are not offered Focus mode (${theme})`, async ({ page }) => {
      await loadScan(page, theme);
      await expect(page.locator(TOGGLE)).toBeHidden();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/390x844-${theme}-off.png` });
      // The palette action explains itself instead of silently doing nothing.
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('olv-focus-mode-toggle')));
      await expect(page.locator('.olv-lasso-toast')).toContainText('Focus mode needs');
      await expect(page.locator('.olv-overlay')).not.toHaveClass(/olv-focus-mode/);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/390x844-${theme}-on-request.png` });
    });
  }
});

test('touch: a tap enters and leaves Focus mode on a tablet', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const page = await ctx.newPage();
  await loadScan(page);
  await page.locator(TOGGLE).tap();
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');
  await page.locator(TOGGLE).tap();
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'false');
  await ctx.close();
});
