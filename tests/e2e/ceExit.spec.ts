/**
 * One exit convention (spec CE-1, CE-EXIT-01 to CE-EXIT-04).
 *
 * Every route and workspace this fixture reaches is visited at 1440x900 and at
 * 390x844, through the palette's Go to entries, and each must show a visible
 * Back that names its destination. Labs, the command palette and result focus
 * are checked the same way; labs are pages under Analyse. The count of dead ends must be zero.
 *
 * Escape follows the order in CE-EXIT-02: a popover first, then a tool that is
 * capturing, then the surface; a text field keeps its Escape; a dialog closes
 * itself without moving the route; focus returns to the control that opened
 * the surface. Deterministic project.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { dropDenseGridPly, dropTinyPtx, openAnalysePage, openToolPage, placeProfile, showWorkspaceMode } from './helpers';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The location bar on screen: the top bar on a desktop, the sheet head on a phone. */
const bar = (page: Page): Locator => page.locator('.olv-loc:not([hidden])');

async function openScan(page: Page, size: { width: number; height: number }, drop = dropDenseGridPly): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/?test=1');
  await drop(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await expect(bar(page)).toBeVisible({ timeout: 10_000 });
}

/** Run a Go to entry from the palette; false when the entry is shown unavailable. */
async function goTo(page: Page, title: string): Promise<boolean> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill(`Go to ${title}`);
  const row = page.locator('.olv-palette-row', { has: page.locator('.olv-palette-row-title', { hasText: new RegExp(`^Go to ${title}$`) }) });
  await expect(row).toHaveCount(1);
  if ((await row.getAttribute('aria-disabled')) === 'true') {
    await page.locator('.olv-palette-close').click();
    return false;
  }
  await row.click();
  await expect(page.locator('.olv-palette')).toBeHidden();
  return true;
}

/**
 * The labelled way back on the current surface, or '' when there is none (a
 * dead end). A dialog's own Back comes first, then the palette's close, then a
 * workspace's close, then the location bar's Back.
 */
async function wayBack(page: Page): Promise<string> {
  const candidates = [
    page.locator('.olv-modal-backdrop .olv-modal-back'),
    page.locator('.olv-palette:not(.olv-hidden) .olv-palette-close'),
    page.locator('.olv-workbench-close'),
    bar(page).locator('.olv-loc-back'),
  ];
  for (const c of candidates) {
    if ((await c.count()) && (await c.first().isVisible())) {
      const name = (await c.first().getAttribute('aria-label')) ?? (await c.first().innerText());
      if (/^(Back to |Close )\S/.test(name)) return name;
    }
  }
  return '';
}

const PAGES: Array<{ title: string; path: string; back: string }> = [
  { title: 'Classes', path: 'Data › Classes', back: 'Back to Data' },
  { title: 'Measure', path: 'Tools › Measure', back: 'Back to Tools' },
  { title: 'Annotate', path: 'Tools › Annotate', back: 'Back to Tools' },
  { title: 'Clip box', path: 'Tools › Clip box', back: 'Back to Tools' },
  { title: 'Terrain', path: 'Analyse › Terrain', back: 'Back to Analyse' },
  { title: 'Contours', path: 'Analyse › Terrain › Contours', back: 'Back to Terrain' },
  { title: 'Objects & Space', path: 'Analyse › Objects & Space', back: 'Back to Analyse' },
  { title: 'Feature candidates', path: 'Analyse › Feature candidates', back: 'Back to Analyse' },
  { title: 'Range frames', path: 'Analyse › Range frames', back: 'Back to Analyse' },
];

async function sweep(page: Page, size: { width: number; height: number }): Promise<{ visited: string[]; deadEnds: string[] }> {
  await openScan(page, size);
  const visited: string[] = [];
  const deadEnds: string[] = [];
  const check = async (label: string): Promise<void> => {
    visited.push(label);
    if (!(await wayBack(page))) deadEnds.push(label);
  };
  // Terrain first, so Contours and the workspaces it unlocks are reachable.
  expect(await goTo(page, 'Terrain')).toBe(true);
  await page.locator('.olv-analyse-run:visible').click();
  await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 90_000 });
  for (const p of PAGES) {
    if (!(await goTo(page, p.title))) continue;
    await expect(bar(page)).toHaveAttribute('data-path', p.path);
    await expect(bar(page).locator('.olv-loc-back')).toHaveAttribute('aria-label', p.back);
    await check(p.path);
  }
  // A workspace: Back says which one it closes.
  if (await goTo(page, 'Contour Studio')) {
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Terrain › Contours › Contour Studio');
    await expect(bar(page).locator('.olv-loc-back')).toHaveText('Close Contour Studio');
    await expect(page.locator('.olv-analyse-contour-deliverable > .olv-ws-close')).toHaveText('Close Contour Studio');
    await check('Contour Studio');
    await bar(page).locator('.olv-loc-back').click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Terrain › Contours');
  }
  // The palette itself has a visible close control.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette-close')).toBeVisible();
  await check('Command palette');
  await page.locator('.olv-palette-close').click();
  await expect(page.locator('.olv-palette')).toBeHidden();
  // A lab is a page under Terrain, and its Back names Terrain.
  // The first crumb goes to the Analyse home from anywhere under it.
  await bar(page).locator('.olv-loc-crumb', { hasText: /^Analyse$/ }).click();
  await expect(bar(page)).toHaveAttribute('data-path', 'Analyse');
  await page.locator('.olv-ah-row[data-analysis="flow-pulse"] .olv-ah-open:visible').click();
  await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Terrain › Flow Pulse', { timeout: 20_000 });
  const labBack = bar(page).locator('.olv-loc-back');
  await expect(labBack).toHaveText('← Terrain');
  await expect(labBack).toHaveAttribute('aria-label', 'Back to Terrain');
  await check('Flow Pulse');
  await labBack.click();
  await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Terrain');
  return { visited, deadEnds };
}

test.describe('one exit convention', () => {
  test.slow();

  for (const [name, size] of [['desktop 1440x900', DESKTOP], ['phone 390x844', PHONE]] as const) {
    test(`${name}: every route, workspace and lab has a named Back; no dead ends`, async ({ page }) => {
      test.setTimeout(300_000);
      const { visited, deadEnds } = await sweep(page, size);
      test.info().annotations.push({ type: 'surfaces', description: visited.join('; ') }, { type: 'dead ends', description: String(deadEnds.length) });
      expect(visited.length).toBeGreaterThanOrEqual(8);
      expect(deadEnds).toEqual([]);
    });
  }

  test('Escape: tool capture first, then the page; focus returns to the opener', async ({ page }) => {
    await openScan(page, DESKTOP);
    await showWorkspaceMode(page, 'work');
    await page.locator('.olv-tool-launcher .olv-tl-row', { hasText: 'Measure' }).first().click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Measure');
    await expect(page.locator('.olv-dock-measure')).toHaveAttribute('aria-pressed', 'true');
    // The capturing tool takes the first Escape. With nothing measured the
    // Measure page closes with its tool, as it always has.
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-dock-measure')).toHaveAttribute('aria-pressed', 'false');
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools');

    // A page with no tool: Escape is Back, and focus returns to the row that opened it.
    await showWorkspaceMode(page, 'data');
    const row = page.locator('.olv-data-row', { hasText: 'Classes' });
    await row.click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Data › Classes');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveAttribute('data-path', 'Data');
    await expect(row).toBeFocused();
  });

  test('Escape: a workspace closes, then each page goes back to its parent', async ({ page }) => {
    test.setTimeout(200_000);
    await openScan(page, DESKTOP);
    await openAnalysePage(page, 'terrain');
    await page.locator('.olv-analyse-run').click();
    await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 90_000 });
    const link = page.locator('.olv-at-link', { hasText: 'Contours' });
    await link.click();
    const launch = page.locator('.olv-analyse-contour-launcher .olv-contour-launcher-action');
    await launch.click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Terrain › Contours › Contour Studio');
    await page.mouse.click(720, 300); // focus leaves the rail; Escape still applies
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Terrain › Contours');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Terrain');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse');
    await page.keyboard.press('Escape'); // a mode home has nowhere further to go
    await page.waitForTimeout(250);
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse');
  });

  test('Escape: a text field, a popover and a dialog keep it', async ({ page }) => {
    await openScan(page, DESKTOP);
    await openToolPage(page, 'Clip box');
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Clip box');
    const clip = page.locator('#olv-ws-mode-work .olv-clip-panel');
    if (await clip.evaluate((e) => e.classList.contains('olv-collapsed'))) await clip.locator('.olv-panel-head').click();
    const field = clip.locator('input[type="number"]').first();
    await expect(field).toBeVisible();
    await field.focus();
    await expect(field).toBeFocused();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250); // a repaint would land within a frame
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Clip box');
    await page.locator('#olv-ws-mode-work .olv-ws-task-title').focus();

    // A popover closes first and the route stays.
    await page.locator('.olv-quality-button').click();
    await expect(page.locator('.olv-quality-button')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-quality-button')).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(250);
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Clip box');

    // Opening the palette closes an open popover: one transient at a time.
    await page.locator('.olv-quality-button').click();
    await expect(page.locator('.olv-quality-button')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.locator('.olv-palette')).toBeVisible();
    await expect(page.locator('.olv-quality-button')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-palette')).toBeHidden();
    await page.waitForTimeout(250);
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Clip box');
  });

  test('a lab page goes back on Escape, and focus returns to its row', async ({ page }) => {
    await openScan(page, DESKTOP, dropTinyPtx);
    await showWorkspaceMode(page, 'analyse');
    const open = page.locator('.olv-ah-row[data-analysis="observatory"] .olv-ah-open');
    await open.click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Observatory', { timeout: 20_000 });
    await expect(bar(page).locator('.olv-loc-back')).toHaveText('← Analyse');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse');
    await expect(page.locator('.olv-modal-backdrop')).toHaveCount(0);
    await expect(open).toBeFocused();
  });

  test('the profile workbench names itself in the bar and closes by name', async ({ page }) => {
    await placeProfile(page);
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Measure');
    const expand = page.locator('.olv-mp-chart-wrap').first();
    await expand.click();
    await expect(page.locator('.olv-workbench')).toBeVisible({ timeout: 20_000 });
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Measure › Profile Workbench');
    await expect(bar(page).locator('.olv-loc-back')).toHaveText('Close Profile Workbench');
    await page.locator('.olv-workbench-close').click();
    await expect(page.locator('.olv-workbench')).toHaveCount(0);
    await expect(bar(page)).toHaveAttribute('data-path', 'Tools › Measure');
    await expect(expand).toBeFocused();
  });

  test('phone: result focus leads with a Back that names the page it returns to', async ({ page }) => {
    await placeProfile(page);
    await page.setViewportSize(PHONE);
    await expect(page.locator('.olv-mobile-sheet')).toBeVisible({ timeout: 10_000 });
    await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="work"]').click();
    const expand = page.locator('.olv-msheet-slot[data-tab="work"] .olv-mp-chart-wrap').first();
    await expand.click();
    const back = page.locator('.olv-result-focus .olv-modal-back');
    await expect(back).toHaveText('← Measure');
    await expect(back).toHaveAttribute('aria-label', 'Back to Measure');
    await back.click();
    await expect(page.locator('.olv-result-focus')).toHaveCount(0);
    await expect(expand).toBeFocused();
  });
});
