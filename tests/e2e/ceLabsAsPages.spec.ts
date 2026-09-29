/**
 * Labs as Analyse pages (spec CE-1, CE-LAB-01 to CE-LAB-05).
 *
 * Flow Pulse and Terrain Access open as pages under Terrain and Observatory as
 * a page of its own, from their Analyse home rows. While a lab page is open no
 * dialog covers the scene: the canvas is on screen and takes a drag, and Back
 * returns to the lab's parent. The Results shelf sends a lab result to its
 * page, showing the kept run. Deterministic project.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { dropDenseGridPly, dropTinyPtx, openAnalysePage, showWorkspaceMode } from './helpers';

const DESKTOP = { width: 1440, height: 900 };

const bar = (page: Page): Locator => page.locator('.olv-loc:not([hidden])');
const labPage = (page: Page, id: string): Locator => page.locator(`.olv-analyse-page[data-page="${id}"]`);

/** The scene is on screen, uncovered at a point right of the rail, and takes a drag. */
async function expectSceneLive(page: Page): Promise<void> {
  await expect(page.locator('.olv-modal-backdrop')).toHaveCount(0);
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const x = Math.round(box!.x + box!.width * 0.7);
  const y = Math.round(box!.y + box!.height * 0.5);
  const hit = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.tagName ?? '', [x, y]);
  expect(hit).toBe('CANVAS');
  // A drag over the scene keeps the page open: the scene is navigable beside it.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 10, { steps: 4 });
  await page.mouse.up();
}

async function openScan(page: Page, drop = dropDenseGridPly): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.goto('/?test=1');
  await drop(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await expect(bar(page)).toBeVisible({ timeout: 10_000 });
}

test.describe('labs are Analyse pages', () => {
  test.slow();

  test('Flow Pulse and Terrain Access open under Terrain from their rows; the scene stays live; Back returns to Terrain', async ({ page }) => {
    test.setTimeout(240_000);
    await openScan(page);
    await openAnalysePage(page, 'terrain');
    await page.locator('.olv-analyse-run').click();
    await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 90_000 });

    for (const [id, name, marker] of [
      ['flow-pulse', 'Flow Pulse', '.olv-story-card'],
      ['terrain-access', 'Terrain Access', '.olv-ta-form'],
    ] as const) {
      // The first crumb is the Analyse home from anywhere under it.
      await bar(page).locator('.olv-loc-crumb', { hasText: /^Analyse$/ }).click();
      await expect(bar(page)).toHaveAttribute('data-path', 'Analyse');
      await page.locator(`.olv-ah-row[data-analysis="${id}"] .olv-ah-open`).click();
      await expect(labPage(page, id)).toBeVisible({ timeout: 20_000 });
      await expect(labPage(page, id).locator(marker)).toBeVisible({ timeout: 20_000 });
      await expect(bar(page)).toHaveAttribute('data-path', `Analyse › Terrain › ${name}`);
      await expect(page.locator('#olv-ws-mode-analyse .olv-ws-task-title')).toHaveText(name);
      await expectSceneLive(page);
      await expect(labPage(page, id)).toBeVisible();
      await page.locator('#olv-ws-mode-analyse > .olv-ws-task .olv-ws-back').click();
      await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Terrain');
      await expect(labPage(page, id)).toBeHidden();
    }
  });

  test('Observatory is a top-level Analyse page; Back returns to Analyse', async ({ page }) => {
    test.setTimeout(180_000);
    await openScan(page, dropTinyPtx);
    await showWorkspaceMode(page, 'analyse');
    await page.locator('.olv-ah-row[data-analysis="observatory"] .olv-ah-open').click();
    await expect(labPage(page, 'observatory').locator('.olv-observatory-section-title')).toHaveCount(5, { timeout: 30_000 });
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Observatory');
    await expectSceneLive(page);
    await bar(page).locator('.olv-loc-back').click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse');
    await expect(labPage(page, 'observatory')).toBeHidden();
    // Go to shows the page as it was left, with nothing rerun.
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('Go to Observatory');
    await page.locator('.olv-palette-input').press('Enter');
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Observatory');
    await expect(labPage(page, 'observatory').locator('.olv-observatory-section-title')).toHaveCount(5);
  });

  test('the Results shelf opens a lab result on its page, not in a dialog', async ({ page }) => {
    test.setTimeout(240_000);
    await openScan(page, dropTinyPtx);
    await showWorkspaceMode(page, 'analyse');
    await page.locator('.olv-ah-row[data-analysis="observatory"] .olv-ah-open').click();
    await expect(labPage(page, 'observatory').locator('.olv-observatory-section-title')).toHaveCount(5, { timeout: 30_000 });
    await showWorkspaceMode(page, 'data');
    await expect(bar(page)).toHaveAttribute('data-path', 'Data');
    const toggle = page.locator('.olv-results-toggle:visible');
    await toggle.click();
    const row = page.locator('.olv-results-row', { hasText: 'Observatory run' });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('.olv-results-focus').click();
    await expect(bar(page)).toHaveAttribute('data-path', 'Analyse › Observatory', { timeout: 20_000 });
    await expect(page.locator('.olv-modal-backdrop')).toHaveCount(0);
    await expect(labPage(page, 'observatory').locator('.olv-observatory-section-title')).toHaveCount(5);
  });
});
