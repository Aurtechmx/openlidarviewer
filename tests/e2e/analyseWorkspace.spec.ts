/**
 * The Analyse mode as a home and its task pages. The home lists one row per
 * analysis with its Process Studio status; Terrain and Objects & Space are
 * pages, Contours is a page under Terrain, and the labs are pages too.
 *
 * Journey C: Analyse -> Terrain -> Run -> Why? -> Contours -> generate -> Back
 * -> Back. Journey D: Terrain Access before a run says it runs terrain first,
 * and its one Run lands on the lab's form with no stop at the Terrain page.
 * Flow Pulse after a run reaches its map in two clicks. A third journey pins that routing is
 * presentation only: the terrain result and the contours read the same, from
 * the same nodes, after walking home, Terrain, Contours and Data.
 * Deterministic project; the dense-grid PLY yields an exploratory contour set.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, dropTerrainAccessUtmLas, showWorkspaceMode, taskBack, clickTaskBack, terrainResultDigest } from './helpers';

const ANALYSE = '#olv-ws-mode-analyse';

async function loadScan(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await showWorkspaceMode(page, 'analyse');
  await expect(page.locator(`${ANALYSE} .olv-analyse-home`)).toBeVisible();
}

const row = (page: Page, id: string) => page.locator(`.olv-ah-row[data-analysis="${id}"]`);
const title = (page: Page) => page.locator(`${ANALYSE} .olv-ws-task-title`);
const back = (page: Page) => taskBack(page, 'analyse');

async function runTerrain(page: Page): Promise<void> {
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, { timeout: 30_000 });
}

const resultDigest = terrainResultDigest;

test.describe('Analyse home and pages', () => {
  test.slow();

  test('Journey C: Terrain, run, Why?, Contours, generate, Back, Back', async ({ page }) => {
    await loadScan(page);
    // The home stands alone: one row per analysis, each with a status.
    for (const id of ['terrain', 'flow-pulse', 'terrain-access', 'observatory', 'objects']) {
      await expect(row(page, id).locator('.olv-ah-badge')).toHaveText(/^(Ready|Review|Blocked|Needs .+|Runs terrain first)$/);
    }
    await expect(page.locator(`${ANALYSE} .olv-process-studio`)).toBeHidden();

    await row(page, 'terrain').locator('.olv-ah-open').click();
    await expect(title(page)).toHaveText('Terrain');
    await expect(title(page)).toBeFocused();
    await expect(page.locator(`${ANALYSE} .olv-analyse-home`)).toBeHidden();
    await runTerrain(page);

    // Conclusion first: after a run the run's verdict is the page's one status
    // line, then Make contours, then Why? with the whole Process Studio behind it.
    const terrain = page.locator(`${ANALYSE} .olv-analyse-page[data-page="terrain"]`);
    await expect(terrain.locator('.olv-fit-verdict')).toBeVisible();
    await expect(terrain.locator('.olv-at-verdict')).toBeHidden();
    const studio = terrain.locator('.olv-process-studio');
    await expect(studio).toBeHidden();
    await terrain.locator('.olv-why-summary').first().click();
    await expect(studio).toBeVisible();
    await expect(studio.locator('.olv-ps-product', { hasText: 'DTM' })).toHaveClass(/olv-ps-produced/);

    // Make contours lands in Contour Studio on the Contours page.
    await terrain.locator('.olv-at-link', { hasText: 'Make contours' }).click();
    await expect(title(page)).toHaveText('Contours');
    await expect(back(page)).toHaveText('← Terrain');
    await expect(page.locator('.olv-analyse-contour-deliverable')).not.toHaveClass(/olv-hidden/, { timeout: 20_000 });
    await expect(page.locator('.olv-cs-export-btn', { hasText: /^GeoJSON$/ })).toBeVisible();

    await clickTaskBack(page, 'analyse');
    await expect(title(page)).toHaveText('Terrain');
    await expect(back(page)).toHaveText('← Analyse');
    await clickTaskBack(page, 'analyse');
    await expect(page.locator(`${ANALYSE} .olv-analyse-home`)).toBeVisible();
    await expect(page.locator(`${ANALYSE} .olv-ws-task`)).toBeHidden();
    // The run is reflected on the home: the labs are no longer blocked on it.
    await expect(row(page, 'flow-pulse')).not.toHaveClass(/is-blocked|is-needs/);
  });

  test('Journey D: Terrain Access runs terrain first in one click and lands on its form', async ({ page }) => {
    await loadScan(page);
    const access = row(page, 'terrain-access');
    await expect(access.locator('.olv-ah-badge')).toHaveText('Runs terrain first');
    await expect(access).toHaveClass(/is-needs/);
    await expect(access.locator('.olv-ah-remedy')).toHaveCount(0);
    await access.locator('.olv-ah-run', { hasText: 'Run Terrain Access' }).click();
    await expect(title(page)).toHaveText('Terrain Access');
    await expect(page.locator('.olv-analyse-page[data-page="terrain-access"] .olv-ta-form')).toBeVisible({ timeout: 30_000 });
    // No dialog, and no stop at the Terrain page on the way.
    await expect(page.locator('.olv-modal')).toHaveCount(0);
    await expect(page.locator('.olv-at-back')).toHaveCount(0);
    // Back home, the row offers the lab as it is.
    await clickTaskBack(page, 'analyse');
    await clickTaskBack(page, 'analyse');
    await expect(access.locator('.olv-ah-run')).toHaveText('Open Terrain Access');
  });

  test('Flow Pulse from scan open: Analyse, then Run Flow Pulse, then the map', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.locator('.olv-ws-tab[data-mode="analyse"]').click(); // 1
    await row(page, 'flow-pulse').locator('.olv-ah-run', { hasText: 'Run Flow Pulse' }).click(); // 2
    const lab = page.locator('.olv-analyse-page[data-page="flow-pulse"]');
    await expect(lab.locator('.olv-flow-grid-canvas')).toBeVisible({ timeout: 30_000 });
    await expect(title(page)).toHaveText('Flow Pulse');
    // The drainage is drawn in 3D when the result opens.
    await expect(lab.locator('.olv-flow-overlay-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  test('navigation never recomputes: results and contours are unchanged across pages and modes', async ({ page }) => {
    await loadScan(page);
    await row(page, 'terrain').locator('.olv-ah-open').click();
    await runTerrain(page);
    await page.locator('.olv-at-link').click(); // Make contours: Contour Studio opens
    await expect(page.locator('.olv-cs-export-btn', { hasText: /^GeoJSON$/ })).toBeVisible({ timeout: 20_000 });
    const before = await resultDigest(page, 'c');
    expect(before.tagged).toBe(0);

    await clickTaskBack(page, 'analyse'); // Terrain
    await clickTaskBack(page, 'analyse'); // home
    await row(page, 'terrain').locator('.olv-ah-open').click();
    await page.locator('.olv-at-link').click();
    await showWorkspaceMode(page, 'data');
    await showWorkspaceMode(page, 'analyse');
    // The tab opens the home; its Continue row returns to the remembered page.
    await page.mouse.move(1, 1);
    await page.locator('#olv-ws-mode-analyse .olv-mode-continue').click();
    await expect(title(page)).toHaveText('Contours');
    await clickTaskBack(page, 'analyse');
    await clickTaskBack(page, 'analyse');

    const after = await resultDigest(page, 'c');
    expect(after.digest).toBe(before.digest);
    // Every result node is the one rendered before: nothing was re-rendered.
    const count = await page.evaluate(() => document.querySelectorAll('.olv-analyse-readiness .olv-analyse-ready, .olv-fit-row, .olv-analyse-score, .olv-analyse-validation, .olv-analyse-contour-launcher > *').length);
    expect(after.tagged).toBe(count);
    // The run button never went busy again.
    await expect(page.locator('.olv-analyse-run')).toBeEnabled();
  });

  test('a not-usable run never reads Ready on the Terrain row or page', async ({ page }) => {
    await page.goto('/?test=1');
    await dropTerrainAccessUtmLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await showWorkspaceMode(page, 'analyse');
    await row(page, 'terrain').locator('.olv-ah-open').click();
    await runTerrain(page);
    await expect(page.locator('.olv-fit-verdict-text')).toHaveText(/Not usable/);
    const header = page.locator(`${ANALYSE} .olv-analyse-page[data-page="terrain"] .olv-at-verdict`);
    await expect(header.locator('.olv-ah-badge')).toHaveText('Blocked');
    await expect(header.locator('.olv-at-reason')).toHaveText(/Not usable/);
    await clickTaskBack(page, 'analyse');
    await expect(row(page, 'terrain').locator('.olv-ah-badge')).toHaveText('Blocked');
    await expect(row(page, 'terrain').locator('.olv-ah-reason')).toHaveText(/Not usable/);
    // Rows that read the DTM are capped by the same run. Running terrain
    // again would not change it, so they offer the lab, not Prepare terrain.
    for (const id of ['flow-pulse', 'terrain-access']) {
      await expect(row(page, id).locator('.olv-ah-badge')).toHaveText('Blocked');
      await expect(row(page, id).locator('.olv-ah-reason')).toHaveText(/^Terrain run: Not usable/);
      await expect(row(page, id).locator('.olv-ah-remedy', { hasText: 'Prepare terrain' })).toHaveCount(0);
    }
    await row(page, 'flow-pulse').locator('.olv-ah-run', { hasText: 'Run Flow Pulse' }).click();
    await expect(title(page)).toHaveText('Flow Pulse');
    // The lab's one status chip carries the same verdict, word for word.
    const chip = page.locator('.olv-analyse-page[data-page="flow-pulse"] .olv-lab-chip');
    await expect(chip.locator('.olv-ah-badge')).toHaveText('Blocked', { timeout: 30_000 });
    await expect(chip.locator('.olv-lab-chip-reason')).toHaveText(/^Terrain run: Not usable/);
  });

  test('Contours in three clicks without a result and two with one', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.locator('.olv-ws-tab[data-mode="analyse"]').click(); // 1
    await row(page, 'terrain').getByRole('button', { name: 'Run terrain analysis' }).click(); // 2
    await expect(title(page)).toHaveText('Terrain');
    const create = page.locator('.olv-at-link', { hasText: 'Contours' });
    await expect(create).toBeVisible({ timeout: 30_000 });
    await create.click(); // 3
    await expect(title(page)).toHaveText('Contours');

    await clickTaskBack(page, 'analyse');
    await clickTaskBack(page, 'analyse');
    await showWorkspaceMode(page, 'data');
    await page.locator('.olv-ws-tab[data-mode="analyse"]').click(); // 1
    await row(page, 'contours').locator('.olv-ah-open').click(); // 2
    await expect(title(page)).toHaveText('Contours');
  });
});
