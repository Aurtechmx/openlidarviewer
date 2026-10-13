import { test, expect, type Page, type Locator } from '@playwright/test';
import { dropTinyPly, pinNavigationPanel } from './helpers';
import { isBenignPageError } from './pageErrors';

/**
 * Plan View and the command palette. The palette's standard views and its
 * projection toggle aim the same camera the navigation bar does, so they must
 * end Plan View the same way: the Plan chip turns off, and the Ortho chip
 * shows the projection the viewer is actually in.
 */

async function loadSample(page: Page): Promise<void> {
  await pinNavigationPanel(page);
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

function chips(page: Page): { plan: Locator; ortho: Locator } {
  const row = page.locator('.olv-cam-views:not(.olv-nav-more-views)');
  return { plan: row.locator('.olv-plan-toggle'), ortho: row.locator('.olv-ortho-toggle') };
}

/** Open the palette, find the command by its exact title, and click it. */
async function runFromPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill(title);
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = page.locator('.olv-palette-row', {
    has: page.locator('.olv-palette-row-title', { hasText: new RegExp(`^${escaped}$`) }),
  });
  await row.first().click();
  await expect(page.locator('.olv-palette')).toBeHidden();
}

/** The navigation mode the bar shows as pressed. */
async function expectMode(page: Page, mode: 'orbit' | 'pan'): Promise<void> {
  await expect(page.locator(`.olv-mode-${mode}`).first()).toHaveAttribute('aria-pressed', 'true');
  const other = mode === 'orbit' ? 'pan' : 'orbit';
  await expect(page.locator(`.olv-mode-${other}`).first()).toHaveAttribute('aria-pressed', 'false');
}

async function enterPlan(page: Page): Promise<void> {
  const { plan, ortho } = chips(page);
  await plan.click();
  await expect(plan).toHaveAttribute('aria-pressed', 'true');
  await expect(ortho).toHaveAttribute('aria-pressed', 'true');
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (!isBenignPageError(e.message)) errors.push(e.message); });
  page.on('console', (m) => {
    if (m.type() === 'error' && !isBenignPageError(m.text())) errors.push(m.text());
  });
  return errors;
}

test.describe('plan view — command palette', () => {
  test('Front view from the palette leaves Plan View', async ({ page }) => {
    const errors = collectErrors(page);
    await loadSample(page);
    await enterPlan(page);
    const { plan, ortho } = chips(page);

    await runFromPalette(page, 'Front view (axis aligned)');
    await expect(page.locator('.olv-lasso-toast')).toHaveText('Camera · Front view.');
    await expect(plan).toHaveAttribute('aria-pressed', 'false');
    // A standard view keeps the projection it was given.
    await expect(ortho).toHaveAttribute('aria-pressed', 'true');
    // Nothing owed by the entry turns the chip back on later.
    await page.waitForTimeout(1_500);
    await expect(plan).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  });

  test('the palette projection toggle leaves Plan View for perspective', async ({ page }) => {
    const errors = collectErrors(page);
    await loadSample(page);
    await enterPlan(page);
    const { plan, ortho } = chips(page);

    // While the scene is parallel, the command names what it switches to.
    await runFromPalette(page, 'Switch to perspective projection');
    await expect(page.locator('.olv-lasso-toast')).toHaveText('Camera · orthographic off.');
    await expect(plan).toHaveAttribute('aria-pressed', 'false');
    await expect(ortho).toHaveAttribute('aria-pressed', 'false');

    // Toggled straight back: parallel again, but no longer Plan View.
    await runFromPalette(page, 'Orthographic projection');
    await expect(page.locator('.olv-lasso-toast')).toHaveText('Camera · orthographic on.');
    await expect(ortho).toHaveAttribute('aria-pressed', 'true');
    await expect(plan).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  });

  // Every way out of Plan View hands the drag back to the mode it found.
  for (const exit of ['the Plan chip', 'Front view from the palette', 'the palette projection toggle'] as const) {
    test(`leaving through ${exit} restores Orbit`, async ({ page }) => {
      const errors = collectErrors(page);
      await loadSample(page);
      await expectMode(page, 'orbit');
      await enterPlan(page);
      await expectMode(page, 'pan');

      if (exit === 'the Plan chip') await chips(page).plan.click();
      else if (exit === 'Front view from the palette') await runFromPalette(page, 'Front view (axis aligned)');
      else await runFromPalette(page, 'Switch to perspective projection');

      await expect(chips(page).plan).toHaveAttribute('aria-pressed', 'false');
      await expectMode(page, 'orbit');
      // Past any settle window, nothing flips it back to the hand tool.
      await page.waitForTimeout(1_500);
      await expectMode(page, 'orbit');
      expect(errors).toEqual([]);
    });
  }

  test('searching "perspective" finds the projection command', async ({ page }) => {
    await loadSample(page);
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('perspective');
    await expect(page.locator('.olv-palette-row-title').first()).toHaveText('Orthographic projection');
    await page.keyboard.press('Escape');
    await enterPlan(page);
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('perspective');
    await expect(page.locator('.olv-palette-row-title').first()).toHaveText('Switch to perspective projection');
  });

  test('Front view while Plan View is still entering cancels it, and the chips match the viewer', async ({ page }) => {
    const errors = collectErrors(page);
    await loadSample(page);
    const { plan, ortho } = chips(page);

    // No wait for the camera to land: the palette interrupts the entry.
    await plan.click();
    await runFromPalette(page, 'Front view (axis aligned)');
    await runFromPalette(page, 'Front view (axis aligned)');
    // Past the entry's settle window, Plan must not light up late.
    await page.waitForTimeout(2_000);
    await expect(plan).toHaveAttribute('aria-pressed', 'false');

    // Whatever the projection ended as, the Ortho chip says it: toggling from
    // the palette must report the opposite of what the chip showed.
    const wasOrtho = (await ortho.getAttribute('aria-pressed')) === 'true';
    await runFromPalette(page, wasOrtho ? 'Switch to perspective projection' : 'Orthographic projection');
    await expect(page.locator('.olv-lasso-toast')).toHaveText(`Camera · orthographic ${wasOrtho ? 'off' : 'on'}.`);
    await expect(ortho).toHaveAttribute('aria-pressed', wasOrtho ? 'false' : 'true');
    await expect(plan).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  });
});
