import { test, expect, type Page } from '@playwright/test';
import {
  activate,
  dropDenseGridPly,
  dropTinyPtx,
  expectHittable,
  placeProfile,
  railChromeSettled,
  showWorkspaceMode,
} from './helpers';

/**
 * Keyboard cell inspection — three findings from the v0.7.0 keyboard-audit
 * lane, all in surfaces whose whole feature was a click-to-inspect canvas:
 *
 *   ANALYSIS-F1: the Range Frame Workbench's acquisition-grid canvas had no
 *   tabIndex, no role, and no keydown handler — the hover/click cell
 *   inspection ("THE SPLIT THAT MATTERS", RangeWorkbench.ts's own words) was
 *   entirely unreachable without a pointer.
 *
 *   ANALYSIS-F2: the Analyse panel's sampled raster tiles (canopy height,
 *   coverage/trust, relief) were the same shape of defect — a bare `click`
 *   listener on an unfocusable canvas.
 *
 *   ANALYSIS-F9: the profile chart's corner Expand button sat, focusable,
 *   inside a chartWrap that already carried the identical action as
 *   role="button" + tabIndex=0 — a redundant tab stop with the same
 *   accessible name.
 *
 * The per-cell mapping and the resolveCellLink/sampleTerrain arithmetic are
 * pinned under Node (tests/rangeWorkbenchKeyboard.test.ts,
 * tests/analyseSurfaceTilesKeyboard.test.ts, tests/measurePanelChartExpandTabOrder.test.ts).
 * What only a browser proves is the real focus order, the real tabindex/role
 * attributes as the browser reflects them, and that a real Tab/Enter sequence
 * reaches the same outcome a real click does.
 */

/** Drop the PTX fixture and reach the Range Frame Workbench's acquisition
 * grid — the shared setup for every cell-inspection test below. */
async function openRangeWorkbenchGrid(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropTinyPtx(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await railChromeSettled(page);
  await openRangeWorkbench(page);
}

async function openRangeWorkbench(page: Page): Promise<void> {
  await showWorkspaceMode(page, 'analyse');
  const panel = page.locator('.olv-analyse-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
  const launcher = page.locator('.olv-range-launcher');
  await expect(launcher).toBeVisible({ timeout: 20_000 });
  const open = launcher.locator('.olv-range-launcher-action');
  await expectHittable(open);
  await activate(open);
  await expect(page.locator('.olv-range-workbench')).toBeVisible();
}

test.describe('Range Frame Workbench — keyboard cell inspection', () => {
  test('the acquisition-grid canvas is a focusable, labelled widget', async ({ page }) => {
    await openRangeWorkbenchGrid(page);

    const canvas = page.locator('.olv-range-canvas');
    await expect(canvas).toHaveAttribute('tabindex', '0');
    await expect(canvas).toHaveAttribute('role', 'application');
    expect(await canvas.getAttribute('aria-label')).toBeTruthy();
  });

  test('arrow keys move a visible cursor; Enter samples it, same as a click', async ({ page }) => {
    await openRangeWorkbenchGrid(page);

    const canvas = page.locator('.olv-range-canvas');
    const marker = page.locator('.olv-range-marker');
    const readout = page.locator('.olv-range-readout-head');

    await expect(marker).toHaveClass(/olv-hidden/);
    await expect(readout).toHaveText('Select a cell');

    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');

    // Movement alone reveals the cursor but does not resolve the cell — same
    // as the mouse, which only resolves on click, never on hover.
    await expect(marker).not.toHaveClass(/olv-hidden/);
    await expect(readout).toHaveText('Select a cell');

    await page.keyboard.press('Enter');
    await expect(readout).not.toHaveText('Select a cell');
  });

  test('mouse click-to-inspect still works unmodified', async ({ page }) => {
    await openRangeWorkbenchGrid(page);

    const canvas = page.locator('.olv-range-canvas');
    const readout = page.locator('.olv-range-readout-head');
    await canvas.click();
    await expect(readout).not.toHaveText('Select a cell');
  });
});

/** Drop the dense fixture and reach the Analyse panel's expanded raster
 * detail — the shared setup for every raster-sampling test below. */
async function openSampledRasterTile(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-ws-tab[data-mode="analyse"]')).toBeVisible({ timeout: 20_000 });
  await openAnalyseDetails(page);
}

async function openAnalyseDetails(page: Page): Promise<void> {
  await showWorkspaceMode(page, 'analyse');
  const panel = page.locator('.olv-analyse-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, {
    timeout: 20_000,
  });
  await page.locator('.olv-analyse-details-summary').click();
}

/** The canopy-height tile: canvas + readout + crosshair, scoped so ordering never matters. */
function chmTile(page: Page) {
  return page.locator('.olv-analyse-raster-tile', {
    has: page.locator('.olv-analyse-sublabel', { hasText: 'Canopy height (CHM)' }),
  });
}

test.describe('Analyse panel — keyboard raster sampling', () => {
  test('a sampled raster tile is a focusable, labelled widget', async ({ page }) => {
    await openSampledRasterTile(page);

    const canvas = chmTile(page).locator('canvas.olv-analyse-raster');
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute('tabindex', '0');
    await expect(canvas).toHaveAttribute('role', 'application');
    expect(await canvas.getAttribute('aria-label')).toBeTruthy();
  });

  test('arrow keys move a visible crosshair without sampling; Enter samples it', async ({ page }) => {
    await openSampledRasterTile(page);

    const tile = chmTile(page);
    const canvas = tile.locator('canvas.olv-analyse-raster');
    const readout = tile.locator('.olv-analyse-sample');
    const crosshair = tile.locator('.olv-analyse-xhair');

    await expect(readout).toContainText('Click the map');
    await expect(crosshair).not.toBeVisible();

    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');

    await expect(crosshair).toBeVisible();
    // Same as the mouse: hovering/moving the cursor never samples on its own.
    await expect(readout).toContainText('Click the map');

    await page.keyboard.press('Enter');
    await expect(readout).toContainText('Sample ·');
  });

  test('mouse click-to-sample still works unmodified', async ({ page }) => {
    await openSampledRasterTile(page);

    const tile = chmTile(page);
    const canvas = tile.locator('canvas.olv-analyse-raster');
    const readout = tile.locator('.olv-analyse-sample');
    // A locator click (not a raw page.mouse.click at a cached bounding box)
    // scrolls the tile into view first — it sits below the fold, under the
    // readiness cards and the Details expander's own content.
    await canvas.click();
    await expect(readout).toContainText('Sample ·');
  });
});

test.describe('Measurements panel — profile chart expander tab order', () => {
  test('the corner Expand button is out of the tab order and the accessibility tree', async ({ page }) => {
    await placeProfile(page);
    const chartExpand = page.locator('.olv-mp-chart-expand').first();
    await expect(chartExpand).toHaveAttribute('tabindex', '-1');
    await expect(chartExpand).toHaveAttribute('aria-hidden', 'true');
  });

  test('tabbing away from the chart wrapper does not land on the corner button', async ({ page }) => {
    await placeProfile(page);
    const chartWrap = page.locator('.olv-mp-chart-wrap').first();
    const chartExpand = page.locator('.olv-mp-chart-expand').first();

    await chartWrap.focus();
    await expect(chartWrap).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(chartExpand).not.toBeFocused();
  });

  test('Enter on the chart wrapper still opens the profile workbench', async ({ page }) => {
    await placeProfile(page);
    const chartWrap = page.locator('.olv-mp-chart-wrap').first();
    await chartWrap.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.olv-workbench')).toBeVisible({ timeout: 10_000 });
  });

  test('the corner button still opens the workbench for a mouse click (unchanged)', async ({ page }) => {
    await placeProfile(page);
    await page.locator('.olv-mp-chart-expand').first().click();
    await expect(page.locator('.olv-workbench')).toBeVisible({ timeout: 10_000 });
  });
});
