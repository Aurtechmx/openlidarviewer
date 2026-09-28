/**
 * Location bar (spec CE-1, CE-LOC-01 to CE-LOC-05).
 *
 * For every route this fixture reaches, and for Contour Studio, the bar reads
 * the route's path. The bar stays visible with the left rail collapsed, at
 * 390x844 as the heading of the phone sheet in every detent, in the three
 * themes and under forced colours. Every crumb but the last navigates, the last
 * carries aria-current="location", and a route change is announced once.
 * Deterministic project.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { dropDenseGridPly, openAnalysePage, openClassesPage, openToolPage, showWorkspaceMode } from './helpers';

const bar = (page: Page): Locator => page.locator('.olv-topbar .olv-loc');
const phoneBar = (page: Page): Locator => page.locator('.olv-mobile-sheet .olv-msheet-head .olv-loc');

async function openScan(page: Page, size = { width: 1440, height: 900 }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
}

/** The crumbs as a user reads them: the visible labels joined by the separator. */
async function visiblePath(loc: Locator): Promise<string> {
  const labels = await loc.locator('.olv-loc-crumb, .olv-loc-here').evaluateAll((els) =>
    els.map((e) => (e.classList.contains('olv-loc-here') ? (e.lastChild?.textContent ?? '') : (e.textContent ?? '')).trim()),
  );
  return labels.join(' › ');
}

async function expectPath(loc: Locator, path: string): Promise<void> {
  await expect(loc).toBeVisible();
  await expect(loc).toHaveAttribute('data-path', path);
  expect(await visiblePath(loc)).toBe(path);
}

async function runTerrainAndOpenContourStudio(page: Page): Promise<void> {
  await openAnalysePage(page, 'terrain');
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 90_000 });
  await page.locator('.olv-at-link', { hasText: 'Contours' }).click();
  await page.locator('.olv-analyse-contour-launcher .olv-contour-launcher-action').click();
  await expect(page.locator('.olv-cs-export-btn', { hasText: /^GeoJSON$/ })).toBeVisible({ timeout: 30_000 });
}

test.describe('location bar', () => {
  test.slow();

  test('desktop: every route reads its path, with the rail open or collapsed', async ({ page }) => {
    test.setTimeout(240_000);
    await openScan(page);
    const loc = bar(page);
    await showWorkspaceMode(page, 'data');
    await expectPath(loc, 'Data');
    await openClassesPage(page);
    await expectPath(loc, 'Data › Classes');
    for (const tool of ['Measure', 'Annotate', 'Clip box'] as const) {
      await openToolPage(page, tool);
      await expectPath(loc, `Tools › ${tool}`);
    }
    await showWorkspaceMode(page, 'output');
    await expectPath(loc, 'Export');
    await showWorkspaceMode(page, 'analyse');
    await expectPath(loc, 'Analyse');
    await openAnalysePage(page, 'terrain');
    await expectPath(loc, 'Analyse › Terrain');
    await runTerrainAndOpenContourStudio(page);
    await expectPath(loc, 'Analyse › Terrain › Contours › Contour Studio');

    // The last crumb is the current location; each crumb's name is its full path.
    const here = loc.locator('[aria-current="location"]');
    await expect(here).toHaveCount(1);
    await expect(here).toContainText('Contour Studio');
    await expect(loc.locator('.olv-loc-crumb', { hasText: /^Terrain$/ })).toHaveAttribute('aria-label', 'Analyse › Terrain');

    // Collapse the rail: the bar stays, with the same path.
    await page.locator('.olv-rail-tab').click();
    await expect(page.locator('#olv-left-panels')).toHaveClass(/olv-rail-collapsed/);
    await expectPath(loc, 'Analyse › Terrain › Contours › Contour Studio');

    // A crumb navigates to its level, and the change is announced once.
    await loc.locator('.olv-loc-crumb', { hasText: /^Terrain$/ }).click();
    await expectPath(loc, 'Analyse › Terrain');
    await expect(page.locator('.olv-visually-hidden[role="status"]')).toHaveText('Location: Analyse, Terrain');
    await loc.locator('.olv-loc-crumb', { hasText: /^Analyse$/ }).click();
    await expectPath(loc, 'Analyse');
  });

  test('desktop: visible in every theme and under forced colours', async ({ page }) => {
    await openScan(page);
    await openToolPage(page, 'Measure');
    for (const theme of ['Light theme', 'High contrast theme', 'Dark theme']) {
      await page.keyboard.press('ControlOrMeta+KeyK');
      await page.locator('.olv-palette-input').fill(theme);
      await expect(page.locator('.olv-palette-row').first()).toContainText(theme);
      await page.locator('.olv-palette-input').press('Enter');
      await expectPath(bar(page), 'Tools › Measure');
    }
    await page.emulateMedia({ forcedColors: 'active' });
    await expectPath(bar(page), 'Tools › Measure');
  });

  test('phone 390x844: the bar heads the sheet in every detent', async ({ page }) => {
    await openScan(page, { width: 390, height: 844 });
    await expect(page.locator('.olv-mobile-sheet')).toBeVisible({ timeout: 10_000 });
    const loc = phoneBar(page);
    await expect(bar(page)).toBeHidden();
    await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="work"]').click();
    await expectPath(loc, 'Tools');
    await page.locator('.olv-msheet-slot[data-tab="work"] .olv-tool-launcher .olv-tl-row', { hasText: 'Measure' }).first().click();
    // Starting a tool lowers the sheet to peek; the location and Back stay on screen.
    await expect(page.locator('.olv-mobile-sheet')).toHaveAttribute('data-detent', 'peek');
    await expectPath(loc, 'Tools › Measure');
    await expect(loc.locator('.olv-loc-back')).toBeVisible();
    const sheet = page.locator('.olv-mobile-sheet');
    await page.locator('.olv-msheet-handle').click();
    await expect(sheet).toHaveAttribute('data-detent', 'full');
    await expectPath(loc, 'Tools › Measure');
    // Drag the handle to mid-screen: the sheet snaps to half.
    const handle = await page.locator('.olv-msheet-handle').boundingBox();
    if (!handle) throw new Error('no sheet handle');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    for (let y = handle.y; y <= 844 / 2; y += 20) await page.mouse.move(handle.x + handle.width / 2, y);
    await page.mouse.move(handle.x + handle.width / 2, 844 / 2);
    await page.mouse.up();
    await expect(sheet).toHaveAttribute('data-detent', 'half');
    await expectPath(loc, 'Tools › Measure');
    await page.emulateMedia({ forcedColors: 'active' });
    await expectPath(loc, 'Tools › Measure');
  });
});
