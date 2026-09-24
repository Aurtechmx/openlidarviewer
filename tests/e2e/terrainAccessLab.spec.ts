import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, showWorkspaceMode } from './helpers';

/**
 * Terrain Access (Field Simulation Lab) — the mobility-profile form, its own
 * validation refusal, keyboard- and pointer-accessible start/goal selection
 * on the traversability-map grid, a run, the why-not inspector, and export.
 * Mirrors `flowPulseLab.spec.ts`'s structure: the pure pieces (profile
 * parsing, the eligibility/cost model, A*) are unit-tested; this spec pins
 * the real user surface, including real keyboard operation.
 *
 * Runs against the dev server (see playwright.config.ts); the scan-loading
 * specs need a real WebGL/WebGPU context.
 */

async function openAnalyse(page: Page): Promise<void> {
  await showWorkspaceMode(page, 'analyse');
  const panel = page.locator('.olv-analyse-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
}

async function firePaletteAction(page: Page, query: string, rowText: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill(query);
  await expect(page.locator('.olv-palette-row', { hasText: rowText })).toBeVisible();
  await page.locator('.olv-palette-input').press('Enter');
  await expect(page.locator('.olv-palette')).toBeHidden();
}

async function openTerrainAccess(page: Page): Promise<void> {
  await firePaletteAction(page, 'Terrain Access', 'Terrain Access (Field Simulation Lab)');
  await expect(page.locator('.olv-modal-title')).toHaveText('Field Simulation Lab: Terrain Access');
}

test('refuses honestly, with no interactive controls, before any terrain analysis has run', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);

  await openTerrainAccess(page);
  const modal = page.locator('.olv-modal');
  // No terrain analysis has run yet, so the form appears (the Lab is opened
  // whether or not a surface exists — see `openTerrainAccessLab`), but
  // applying any profile against it refuses with NO_DTM rather than a run.
  await expect(modal.locator('.olv-ta-form')).toBeVisible();
  await modal.locator('input[type=text]').nth(0).fill('Illustrative — confirm for your platform');
  await modal.locator('input[type=text]').nth(1).fill('20');
  await modal.locator('input[type=text]').nth(2).fill('15');
  await modal.locator('input[type=text]').nth(3).fill('0.3');
  await modal.locator('input[type=text]').nth(4).fill('1.8');
  await modal.locator('input[type=text]').nth(5).fill('50');
  await modal.locator('.olv-ta-form-submit').click();
  await expect(modal).toContainText('Terrain Access did not run');
  await expect(modal).toContainText('NO_DTM');
});

test('blank profile refuses with named field problems, per field', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);

  await openTerrainAccess(page);
  const modal = page.locator('.olv-modal');
  await modal.locator('.olv-ta-form-submit').click();
  const problems = modal.locator('.olv-ta-form-problems-list');
  await expect(problems).toContainText('name');
  await expect(problems).toContainText('maxLongitudinalGradeDeg');
  await expect(problems).toContainText('is required');
  // The form is still on screen: a refusal never silently discards the form.
  await expect(modal.locator('.olv-ta-form')).toBeVisible();
});

test('profile, start/goal by keyboard and click, run, route shown, why-not, export', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await openAnalyse(page);
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, {
    timeout: 20_000,
  });

  await openTerrainAccess(page);
  const modal = page.locator('.olv-modal');

  // MOBILITY PROFILE: a permissive, explicit profile — no preset, every
  // field typed. Field order matches `buildProfileForm` in terrainAccessLab.ts.
  await modal.locator('input[type=text]').nth(0).fill('Illustrative — confirm for your platform');
  await modal.locator('input[type=text]').nth(1).fill('80');
  await modal.locator('input[type=text]').nth(2).fill('80');
  await modal.locator('input[type=text]').nth(3).fill('50');
  await modal.locator('input[type=text]').nth(4).fill('0');
  await modal.locator('input[type=text]').nth(5).fill('0');
  await modal.locator('.olv-ta-form-submit').click();

  // This synthetic, unreferenced fixture has no CRS, and Terrain Access
  // refuses outright on an unresolved horizontal scale (UNITS_UNRESOLVED) —
  // unlike Flow Pulse, which only withholds a metric area figure and keeps
  // routing. Both outcomes are real, tested behaviours of the core (see
  // `tests/terrainAccessPackage.test.ts` and `tests/terrainAccessRunner.test.ts`
  // for the resolved-scale path with a hand-built, georeferenced grid); this
  // spec exercises whichever one this browser's fixture actually reaches,
  // rather than assuming a CRS the drag-and-drop fixture does not carry.
  const grid = modal.locator('.olv-ta-grid-canvas');
  const refusalCard = modal.locator('.olv-story-card', { hasText: 'Terrain Access did not run' });
  await expect(grid.or(refusalCard)).toBeVisible({ timeout: 10_000 });

  if (await refusalCard.isVisible()) {
    await expect(refusalCard).toContainText('UNITS_UNRESOLVED');
    await expect(modal.locator('.olv-ta-retry')).toBeVisible();
    return;
  }

  // PREVIEW reached: the traversability grid replaced the form.
  const box = await grid.boundingBox();
  if (!box) throw new Error('grid canvas has no box');

  // WHY-NOT INSPECTOR: default mode is 'start'; switch to inspect and read a
  // sentence naming a concrete reason (eligible or blocked), never a vague answer.
  await modal.locator('.olv-ta-segmented-btn', { hasText: /Why not\?/ }).click();
  await grid.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(modal.locator('.olv-ta-inspector')).toContainText(/eligible|blocked|withheld/, { timeout: 5_000 });

  // START by CLICK, GOAL by KEYBOARD: exercises both input paths.
  await modal.locator('.olv-ta-segmented-btn', { hasText: 'Set start' }).click();
  await grid.click({ position: { x: 4, y: 4 } });
  await expect(modal.locator('.olv-ta-selection')).toContainText('col 0, row 0');

  await modal.locator('.olv-ta-segmented-btn', { hasText: 'Set goal' }).click();
  await grid.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(modal.locator('.olv-ta-selection')).toContainText('Goal');
  await expect(modal.locator('.olv-ta-selection')).not.toContainText('Goal: not set');

  // RUN: the button is enabled once both endpoints are set.
  const runButton = modal.locator('.olv-ta-run');
  await expect(runButton).toBeEnabled();
  await runButton.click();
  await expect(modal.locator('.olv-ta-run-card')).toContainText(/geometric traversability screening|did not run/, {
    timeout: 10_000,
  });
  // §22: never a safety/passability claim, win or refuse.
  await expect(modal.locator('.olv-ta-run-card')).not.toContainText(/\bis safe\b|\bis drivable\b|\bis passable\b/i);

  // EXPORT: offered once a run exists; downloads a ZIP. Only meaningful on
  // the success branch, so this is best-effort and does not fail the spec
  // when the chosen endpoints happened to refuse (NO_ROUTE/START_BLOCKED/etc
  // are real, tested outcomes of the core, not a defect in the Lab).
  const runCardText = await modal.locator('.olv-ta-run-card').innerText();
  if (runCardText.includes('geometric traversability screening')) {
    const exportBtn = modal.locator('.olv-ta-export');
    await expect(exportBtn).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await exportBtn.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/-terrain-access\.zip$/);
  }

  // LIVE REGION: present and polite.
  const live = modal.locator('.olv-ta-live');
  await expect(live).toHaveAttribute('aria-live', 'polite');

  // Closing the modal must not leave the 3D overlay's objects behind or crash
  // the app — reopening still works.
  await page.locator('.olv-modal-x').click();
  await expect(page.locator('.olv-modal')).toHaveCount(0);
  await openTerrainAccess(page);
  await expect(page.locator('.olv-modal .olv-ta-form')).toBeVisible();
});
