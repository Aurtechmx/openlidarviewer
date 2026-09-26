/**
 * The Analyse mode as a home and its task pages. The home lists one row per
 * analysis with its Process Studio status; Terrain and Objects & Space are
 * pages, Contours is a page under Terrain, and the labs stay modals.
 *
 * Journey C: Analyse -> Terrain -> Run -> Why? -> Contours -> generate -> Back
 * -> Back. Journey D: Terrain Access is BLOCKED before a run, and its Prepare
 * terrain fix lands on the Terrain page. A third journey pins that routing is
 * presentation only: the terrain result and the contours read the same, from
 * the same nodes, after walking home, Terrain, Contours and Data.
 * Deterministic project; the dense-grid PLY yields an exploratory contour set.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, dropTerrainAccessUtmLas, showWorkspaceMode } from './helpers';

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
const back = (page: Page) => page.locator(`${ANALYSE} .olv-ws-back`);

async function runTerrain(page: Page): Promise<void> {
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, { timeout: 30_000 });
}

/**
 * A digest of what the terrain run and the contour step put on screen: the
 * evidence text, the fitness verdict, the Contour Studio launcher, and the
 * surface raster pixels. Each node is also tagged, so a re-render (which
 * replaces the nodes) reads as a missing tag even when the text matches.
 */
async function resultDigest(page: Page, tag: string): Promise<{ digest: string; tagged: number }> {
  return page.evaluate(async (t) => {
    const nodes = [
      ...document.querySelectorAll('.olv-analyse-readiness .olv-analyse-ready, .olv-fit-row, .olv-analyse-score, .olv-analyse-validation, .olv-analyse-contour-launcher > *'),
    ] as (HTMLElement & { __probe?: string })[];
    let tagged = 0;
    for (const n of nodes) {
      if (n.__probe === t) tagged++;
      n.__probe ??= t;
    }
    const rasters = [...document.querySelectorAll('canvas.olv-analyse-raster')] as HTMLCanvasElement[];
    const text = nodes.map((n) => n.textContent ?? '').join('\n') + rasters.map((c) => c.toDataURL()).join('\n');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return { digest: [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''), tagged };
  }, tag);
}

test.describe('Analyse home and pages', () => {
  test.slow();

  test('Journey C: Terrain, run, Why?, Contours, generate, Back, Back', async ({ page }) => {
    await loadScan(page);
    // The home stands alone: one row per analysis, each with a status.
    for (const id of ['terrain', 'flow-pulse', 'terrain-access', 'observatory', 'objects']) {
      await expect(row(page, id).locator('.olv-ah-badge')).toHaveText(/^(Ready|Review|Blocked)$/);
    }
    await expect(page.locator(`${ANALYSE} .olv-process-studio`)).toBeHidden();

    await row(page, 'terrain').locator('.olv-ah-open').click();
    await expect(title(page)).toHaveText('Terrain');
    await expect(title(page)).toBeFocused();
    await expect(page.locator(`${ANALYSE} .olv-analyse-home`)).toBeHidden();
    await runTerrain(page);

    // Conclusion first, then Why? with the whole Process Studio behind it.
    const terrain = page.locator(`${ANALYSE} .olv-analyse-page[data-page="terrain"]`);
    await expect(terrain.locator('.olv-at-verdict .olv-ah-badge')).toBeVisible();
    const studio = terrain.locator('.olv-process-studio');
    await expect(studio).toBeHidden();
    await terrain.locator('.olv-why-summary').first().click();
    await expect(studio).toBeVisible();
    await expect(studio.locator('.olv-ps-product', { hasText: 'DTM' })).toHaveClass(/olv-ps-produced/);

    await terrain.locator('.olv-at-link', { hasText: 'Contours' }).click();
    await expect(title(page)).toHaveText('Contours');
    await expect(back(page)).toHaveText('← Terrain');
    const launch = page.locator('.olv-analyse-contour-launcher .olv-contour-launcher-action');
    await expect(launch).toBeVisible({ timeout: 20_000 });
    await launch.click();
    await expect(page.locator('.olv-analyse-contour-deliverable')).not.toHaveClass(/olv-hidden/);
    await expect(page.locator('.olv-cs-export-btn', { hasText: /^GeoJSON$/ })).toBeVisible();

    await back(page).click();
    await expect(title(page)).toHaveText('Terrain');
    await expect(back(page)).toHaveText('← Analyse');
    await back(page).click();
    await expect(page.locator(`${ANALYSE} .olv-analyse-home`)).toBeVisible();
    await expect(page.locator(`${ANALYSE} .olv-ws-task`)).toBeHidden();
    // The run is reflected on the home: the labs are no longer blocked on it.
    await expect(row(page, 'flow-pulse')).not.toHaveClass(/is-blocked/);
  });

  test('Journey D: Terrain Access is BLOCKED and Prepare terrain lands on Terrain', async ({ page }) => {
    await loadScan(page);
    const access = row(page, 'terrain-access');
    await expect(access.locator('.olv-ah-badge')).toHaveText('Blocked');
    await expect(access.locator('.olv-ah-reason')).toHaveText(/terrain run/);
    await access.locator('.olv-ah-remedy', { hasText: 'Prepare terrain' }).click();
    await expect(title(page)).toHaveText('Terrain');
    await expect(page.locator('.olv-analyse-run')).toBeVisible();
    // No lab opened on the way.
    await expect(page.locator('.olv-modal')).toHaveCount(0);
  });

  test('navigation never recomputes: results and contours are unchanged across pages and modes', async ({ page }) => {
    await loadScan(page);
    await row(page, 'terrain').locator('.olv-ah-open').click();
    await runTerrain(page);
    await page.locator('.olv-at-link').click();
    const launch = page.locator('.olv-analyse-contour-launcher .olv-contour-launcher-action');
    await expect(launch).toBeVisible({ timeout: 20_000 });
    await launch.click();
    const before = await resultDigest(page, 'c');
    expect(before.tagged).toBe(0);

    await back(page).click(); // Terrain
    await back(page).click(); // home
    await row(page, 'terrain').locator('.olv-ah-open').click();
    await page.locator('.olv-at-link').click();
    await showWorkspaceMode(page, 'data');
    await showWorkspaceMode(page, 'analyse');
    await expect(title(page)).toHaveText('Contours'); // the mode remembers its page
    await back(page).click();
    await back(page).click();

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
    await back(page).click();
    await expect(row(page, 'terrain').locator('.olv-ah-badge')).toHaveText('Blocked');
    await expect(row(page, 'terrain').locator('.olv-ah-reason')).toHaveText(/Not usable/);
    // Rows that read the DTM are capped by the same run, and their fix is Terrain.
    for (const id of ['flow-pulse', 'terrain-access']) {
      await expect(row(page, id).locator('.olv-ah-badge')).toHaveText('Blocked');
      await expect(row(page, id).locator('.olv-ah-reason')).toHaveText(/^Terrain run: Not usable/);
    }
    await row(page, 'flow-pulse').locator('.olv-ah-remedy', { hasText: 'Prepare terrain' }).click();
    await expect(title(page)).toHaveText('Terrain');
  });

  test('Contours in three clicks without a result and two with one', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.locator('.olv-ws-tab[data-mode="analyse"]').click(); // 1
    await row(page, 'terrain').getByRole('button', { name: 'Run terrain analysis' }).click(); // 2
    await expect(title(page)).toHaveText('Terrain');
    const create = page.locator('.olv-at-link', { hasText: 'Create contours' });
    await expect(create).toBeVisible({ timeout: 30_000 });
    await create.click(); // 3
    await expect(title(page)).toHaveText('Contours');

    await back(page).click();
    await back(page).click();
    await showWorkspaceMode(page, 'data');
    await page.locator('.olv-ws-tab[data-mode="analyse"]').click(); // 1
    await row(page, 'contours').locator('.olv-ah-open').click(); // 2
    await expect(title(page)).toHaveText('Contours');
  });
});
