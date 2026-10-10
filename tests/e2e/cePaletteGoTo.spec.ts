/**
 * Palette "Go to" (spec CE-1, CE-LOC-06).
 *
 * The command palette lists one Go to entry per registered page and workspace,
 * from the same registry the location bar reads. Each available entry lands on
 * its page (the location bar says so); an unavailable one is disabled and
 * shows its one-line reason. With the scan closed, every entry says why.
 * Deterministic project.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, closeScanFromDock } from './helpers';

const ENTRIES: Array<{ title: string; path: string }> = [
  { title: 'Classes', path: 'Data › Classes' },
  { title: 'Measure', path: 'Tools › Measure' },
  { title: 'Annotate', path: 'Tools › Annotate' },
  { title: 'Clip box', path: 'Tools › Clip box' },
  { title: 'Terrain', path: 'Analyse › Terrain' },
  { title: 'Contours', path: 'Analyse › Terrain › Contours' },
  { title: 'Objects & Space', path: 'Analyse › Objects & Space' },
  { title: 'Feature candidates', path: 'Analyse › Feature candidates' },
  { title: 'Range frames', path: 'Analyse › Range frames' },
  { title: 'Flow Pulse', path: 'Analyse › Terrain › Flow Pulse' },
  { title: 'Terrain Access', path: 'Analyse › Terrain › Terrain Access' },
  { title: 'Observatory', path: 'Analyse › Observatory' },
  { title: 'Contour Studio', path: 'Analyse › Terrain › Contours › Contour Studio' },
  { title: 'Range Workbench', path: 'Analyse › Range frames › Range Workbench' },
  { title: 'Feature review', path: 'Analyse › Feature candidates › Feature review' },
  { title: 'Profile Workbench', path: 'Tools › Measure › Profile Workbench' },
];

async function paletteRow(page: Page, title: string) {
  await page.locator('.olv-palette-input').fill(`Go to ${title}`);
  return page.locator('.olv-palette-row', { has: page.locator('.olv-palette-row-title', { hasText: new RegExp(`^Go to ${title}$`) }) });
}

test.describe('palette Go to', () => {
  test.slow();

  test('every registered page and workspace is listed; available ones land, others say why', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
    const loc = page.locator('.olv-topbar .olv-loc');
    await expect(loc).toBeVisible();

    let available = 0;
    let unavailable = 0;
    for (const e of ENTRIES) {
      await page.keyboard.press('ControlOrMeta+KeyK');
      const row = await paletteRow(page, e.title);
      await expect(row).toHaveCount(1);
      // The hint is the entry's place in the location bar.
      await expect(row.locator('.olv-palette-row-hint')).toBeVisible();
      if ((await row.getAttribute('aria-disabled')) === 'true') {
        unavailable += 1;
        const reason = (await row.locator('.olv-palette-row-hint').innerText()).trim();
        expect(reason.length).toBeGreaterThan(5);
        await expect(row).toHaveAttribute('aria-label', new RegExp(`^Go to ${e.title}, unavailable: `));
        await row.dispatchEvent('click'); // a disabled entry does nothing
        await expect(page.locator('.olv-palette')).toBeVisible();
        await page.locator('.olv-palette-close').click();
        continue;
      }
      available += 1;
      await expect(row.locator('.olv-palette-row-hint')).toHaveText(e.path);
      await row.click();
      await expect(page.locator('.olv-palette')).toBeHidden();
      await expect(loc).toHaveAttribute('data-path', e.path);
    }
    // This fixture has no classified or structured data, and no terrain run yet.
    expect(available).toBeGreaterThanOrEqual(7);
    expect(unavailable).toBeGreaterThanOrEqual(1);
  });

  test('with the scan closed, every Go to entry is disabled with its reason', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
    await closeScanFromDock(page);
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.olv-topbar .olv-loc')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('Go to');
    const rows = page.locator('.olv-palette-row', { has: page.locator('.olv-palette-row-title', { hasText: /^Go to / }) });
    await expect(rows).toHaveCount(ENTRIES.length);
    for (let i = 0; i < ENTRIES.length; i += 1) {
      await expect(rows.nth(i)).toHaveAttribute('aria-disabled', 'true');
      await expect(rows.nth(i).locator('.olv-palette-row-hint')).toHaveText('Open a scan first.');
    }
  });
});
