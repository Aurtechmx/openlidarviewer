/**
 * Workspace journeys A to F across the four modes, with the UX rules checked
 * at every stop: one task surface per mode, bordered nesting at most two deep,
 * no scroller inside another scroller, Back on screen on every page, and a
 * heading that takes focus. Routing is presentation only, so the terrain
 * result reads the same (same digest, same nodes) whichever route shows it.
 *
 * A: Data home -> Layer Health in the Inspector -> Classes page -> Back.
 * B: Measure -> Results -> Data -> back to Measure with its state.
 * C: Analyse -> Terrain -> Run -> Why? -> Contours -> generate -> Results -> back.
 * D: a lab blocked on the terrain run -> Prepare terrain -> the Terrain page.
 * E: Results -> the terrain result -> Export with the DEM package preselected.
 * F: two scans; a result keeps its source and Focus does not retarget.
 * Deterministic, Firefox and WebKit projects.
 */
import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dropDenseGridPly, dropTinyLas, placeTestDistance, showWorkspaceMode, terrainResultDigest } from './helpers';

const MULTICHUNK = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));
const shelf = (page: Page) => page.locator('#olv-left-panels .olv-results-shelf');
const modeHost = (page: Page, m: string) => page.locator(`#olv-ws-mode-${m}`);
const taskTitle = (page: Page, m: string) => page.locator(`#olv-ws-mode-${m} .olv-ws-task-title`);
const backBtn = (page: Page, m: string) => page.locator(`#olv-ws-mode-${m} .olv-ws-back`);

/** The UX rules every stop in the rail must keep. */
async function expectWorkspaceRules(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const rail = document.querySelector('#olv-left-panels') as HTMLElement;
    const vis = (el: Element): boolean => {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden';
    };
    const control = (el: Element): boolean =>
      /^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|CANVAS|LABEL|A)$/.test(el.tagName) || el.getAttribute('role') === 'button';
    const boxed = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      return (['Top', 'Right', 'Bottom', 'Left'] as const).every(
        (s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none',
      );
    };
    const all = Array.from(rail.querySelectorAll('*')).filter((el) => vis(el));
    const boxes = new Set(all.filter((el) => !control(el) && boxed(el)));
    let depth = 0;
    let chain = '';
    for (const b of boxes) {
      const names = [b.className];
      for (let p = b.parentElement; p && p !== rail; p = p.parentElement) if (boxes.has(p)) names.push(p.className);
      if (names.length > depth) { depth = names.length; chain = names.join(' < '); }
    }
    const scroller = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    };
    const scrollers = all.filter(scroller);
    const nested = scrollers.filter((s) => scrollers.some((o) => o !== s && o.contains(s))).length;
    const active = Array.from(rail.querySelectorAll('.olv-ws-mode')).filter((m) => vis(m));
    const host = active[0] as HTMLElement | undefined;
    const onPage = !!host?.classList.contains('has-page');
    const back = host?.querySelector('.olv-ws-back');
    const inView = (el: Element): boolean => {
      const b = el.getBoundingClientRect();
      const box = rail.getBoundingClientRect();
      return b.top >= box.top - 1 && b.bottom <= box.bottom + 1;
    };
    return { surfaces: active.length, depth, chain, nested, onPage, backShown: !!back && vis(back) && inView(back) };
  });
  expect(r.surfaces, 'one task surface per mode').toBe(1);
  expect(r.depth, `bordered nesting depth: ${r.chain}`).toBeLessThanOrEqual(2);
  expect(r.nested, 'scrollers inside scrollers').toBe(0);
  if (r.onPage) expect(r.backShown, 'Back on screen on a page').toBe(true);
}

async function openDense(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500); // the test API mounts on viewerLoaded
}

const placeDistance = placeTestDistance;

const terrainDigest = terrainResultDigest;

test.describe('workspace journeys', () => {
  test.slow();

  test('A: Data home, Layer Health in the Inspector, Classes page, Back', async ({ page }) => {
    await page.goto('/');
    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await showWorkspaceMode(page, 'data');
    await expect(page.locator('.olv-ws-tab[data-mode="data"]')).toHaveAttribute('aria-selected', 'true');
    const data = modeHost(page, 'data');
    await expect(data.locator('.olv-layers-section')).toBeVisible();
    await expectWorkspaceRules(page);

    await expect(page.locator('.olv-inspector .olv-layerhealth-card')).toHaveCount(1, { timeout: 20_000 });
    await data.locator('.olv-data-row', { hasText: 'Classes' }).click();
    await expect(taskTitle(page, 'data')).toHaveText('Classes');
    await expect(taskTitle(page, 'data')).toBeFocused();
    await expect(taskTitle(page, 'data')).toHaveAttribute('aria-current', 'page');
    await expectWorkspaceRules(page);

    // Keyboard Back: focus the button and press Enter.
    await backBtn(page, 'data').focus();
    await page.keyboard.press('Enter');
    await expect(data.locator('.olv-data-row', { hasText: 'Classes' })).toBeVisible();
    await expect(taskTitle(page, 'data')).toBeHidden();
    await expectWorkspaceRules(page);
  });

  test('B: Measure, Results, Data, and back to Measure with its state', async ({ page }) => {
    await openDense(page);
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await placeDistance(page);
    await expect(taskTitle(page, 'work')).toHaveText('Measure');
    await expectWorkspaceRules(page);

    await page.mouse.move(1, 1); // a hover tip left by the last click would cover the toggle
    await shelf(page).locator('.olv-results-toggle').click();
    await expect(shelf(page).locator('.olv-results-row[data-result-type="measurement"]')).toHaveCount(1);
    await showWorkspaceMode(page, 'data');
    await expect(page.locator('.olv-measure-panel')).toBeHidden();
    await expectWorkspaceRules(page);

    await shelf(page).locator('.olv-results-row[data-result-type="measurement"] .olv-results-focus').click();
    await expect(page.locator('.olv-ws-tab[data-mode="work"]')).toHaveAttribute('aria-selected', 'true');
    await expect(taskTitle(page, 'work')).toHaveText('Measure');
    await expect(page.locator('.olv-mp-row')).toHaveCount(1);
    await expectWorkspaceRules(page);

    // The tab alone also returns to the remembered page.
    await showWorkspaceMode(page, 'data');
    await showWorkspaceMode(page, 'work');
    await expect(taskTitle(page, 'work')).toHaveText('Measure');
    await expect(page.locator('.olv-mp-row')).toHaveCount(1);
  });

  test('C: Terrain, run, Why?, Contours, generate, Results, and back', async ({ page }) => {
    await openDense(page);
    await showWorkspaceMode(page, 'analyse');
    await expectWorkspaceRules(page);
    await page.locator('.olv-ah-row[data-analysis="terrain"] .olv-ah-open').click();
    await expect(taskTitle(page, 'analyse')).toHaveText('Terrain');
    await expect(taskTitle(page, 'analyse')).toBeFocused();
    await page.locator('.olv-analyse-run').click();
    await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, { timeout: 30_000 });
    // Completion never switches the mode or the page.
    await expect(page.locator('.olv-ws-tab[data-mode="analyse"]')).toHaveAttribute('aria-selected', 'true');
    await expect(taskTitle(page, 'analyse')).toHaveText('Terrain');
    await expectWorkspaceRules(page);

    const terrain = modeHost(page, 'analyse').locator('.olv-analyse-page[data-page="terrain"]');
    await terrain.locator('.olv-why-summary').first().click();
    await expect(terrain.locator('.olv-process-studio')).toBeVisible();
    const first = await terrainDigest(page, 'c');

    await terrain.locator('.olv-at-link', { hasText: 'Contours' }).click();
    await expect(taskTitle(page, 'analyse')).toHaveText('Contours');
    await page.locator('.olv-analyse-contour-launcher .olv-contour-launcher-action').click();
    await expect(page.locator('.olv-cs-export-btn', { hasText: /^GeoJSON$/ })).toBeVisible();
    await expectWorkspaceRules(page);

    await page.mouse.move(1, 1); // a hover tip left by the last click would cover the toggle
    await shelf(page).locator('.olv-results-toggle').click();
    const contours = shelf(page).locator('.olv-results-row[data-result-type="contours"]');
    await expect(contours).toHaveCount(1, { timeout: 10_000 });
    await showWorkspaceMode(page, 'data');
    await shelf(page).locator('.olv-results-row[data-result-type="terrain"] .olv-results-focus').click();
    await expect(page.locator('.olv-ws-tab[data-mode="analyse"]')).toHaveAttribute('aria-selected', 'true');
    await expect(taskTitle(page, 'analyse')).toHaveText('Terrain');

    // Same result, same nodes: nothing re-ran on the way.
    const again = await terrainDigest(page, 'c');
    expect(again.digest).toBe(first.digest);
    expect(again.tagged).toBe(first.count);

    await backBtn(page, 'analyse').click();
    await expect(modeHost(page, 'analyse').locator('.olv-analyse-home')).toBeVisible();
    await expectWorkspaceRules(page);
  });

  test('D: a blocked lab, Prepare terrain, the Terrain page', async ({ page }) => {
    await openDense(page);
    await showWorkspaceMode(page, 'analyse');
    const access = page.locator('.olv-ah-row[data-analysis="terrain-access"]');
    await expect(access.locator('.olv-ah-badge')).toHaveText('Blocked');
    await access.locator('.olv-ah-remedy', { hasText: 'Prepare terrain' }).click();
    await expect(taskTitle(page, 'analyse')).toHaveText('Terrain');
    await expect(page.locator('.olv-analyse-run')).toBeVisible();
    await expect(page.locator('.olv-modal')).toHaveCount(0);
    await expectWorkspaceRules(page);
  });

  test('E: Results, the terrain result, Export with the DEM package preselected', async ({ page }) => {
    await openDense(page);
    await showWorkspaceMode(page, 'analyse');
    await page.locator('.olv-ah-row[data-analysis="terrain"] .olv-ah-open').click();
    await page.locator('.olv-analyse-run').click();
    await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 30_000 });
    await page.mouse.move(1, 1); // a hover tip left by the last click would cover the toggle
    await shelf(page).locator('.olv-results-toggle').click();
    await shelf(page).locator('.olv-results-row[data-result-type="terrain"] .olv-results-export').click();
    await expect(page.locator('.olv-ws-tab[data-mode="output"]')).toHaveAttribute('aria-selected', 'true');
    const dem = page.locator('.olv-export-product-group[data-product="terrain-dem"]');
    await expect(dem).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.olv-export-product-group.is-selected')).toHaveCount(1);
    await expectWorkspaceRules(page);
  });

  test('F: two scans, a result keeps its source and Focus does not retarget', async ({ page }) => {
    await openDense(page);
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await placeDistance(page);
    await showWorkspaceMode(page, 'data');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.olv-add-dataset-row').click();
    await (await chooser).setFiles(MULTICHUNK);
    await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 60_000 });
    const activeBefore = await page.evaluate(() => document.querySelector('.olv-layer.is-active .olv-layer-name')?.textContent ?? null);

    await page.mouse.move(1, 1); // a hover tip left by the last click would cover the toggle
    await shelf(page).locator('.olv-results-toggle').click();
    const row = shelf(page).locator('.olv-results-row[data-result-type="measurement"]');
    await expect(row).toHaveClass(/is-other-source/, { timeout: 5_000 });
    await expect(row.locator('.olv-results-meta')).toContainText('From dense-grid.ply');
    await row.locator('.olv-results-focus').click();
    const activeAfter = await page.evaluate(() => document.querySelector('.olv-layer.is-active .olv-layer-name')?.textContent ?? null);
    expect(activeAfter).toBe(activeBefore);
    await expectWorkspaceRules(page);
  });
});

test.describe('workspace a11y', () => {
  test('tabs carry aria-selected, focus is visible, and a phone keeps 44px targets', async ({ page, browserName }) => {
    await openDense(page);
    await showWorkspaceMode(page, 'work');
    await expect(page.locator('.olv-ws-tab[data-mode="work"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('.olv-tool-launcher .olv-tl-row', { hasText: 'Measure' }).click();
    const back = backBtn(page, 'work');
    await page.keyboard.press('Shift'); // a key first, so focus counts as keyboard focus
    await back.focus();
    // Safari moves Tab only between form fields unless the viewer opts in, so
    // the Tab round trip runs on the other engines.
    if (browserName !== 'webkit') {
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
    }
    await expect(back).toBeFocused();
    if (browserName === 'webkit') {
      // WebKit does not treat scripted focus as keyboard focus, and Tab alone
      // skips buttons. Option+Tab walks every control, as in Safari, so the
      // ring below is a live keyboard ring there too.
      await page.keyboard.press('Alt+Tab');
      await page.keyboard.press('Alt+Shift+Tab');
    }
    await expect(back).toBeFocused();
    const ring = await back.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { fv: el.matches(':focus-visible'), outline: cs.outlineStyle, outlineWidth: parseFloat(cs.outlineWidth), shadow: cs.boxShadow };
    });
    expect(ring.fv, 'keyboard focus matches :focus-visible').toBe(true);
    const drawn = (ring.outline !== 'none' && ring.outlineWidth > 0) || (ring.shadow !== 'none' && ring.shadow !== '');
    expect(drawn, `computed ring ${JSON.stringify(ring)}`).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.olv-mobile-sheet')).toBeVisible({ timeout: 10_000 });
    for (const id of ['data', 'work', 'analyse', 'output', 'view']) {
      const box = await page.locator(`.olv-mobile-sheet .olv-msheet-tab[data-tab="${id}"]`).boundingBox();
      expect(box?.height ?? 0, `${id} tab height`).toBeGreaterThanOrEqual(44);
    }
  });
});

/** Width and height of each visible match. */
async function targetSizes(page: Page, selector: string): Promise<Array<{ w: number; h: number }>> {
  return page.evaluate((sel) => Array.from(document.querySelectorAll(sel))
    .map((e) => e.getBoundingClientRect())
    .filter((b) => b.width > 0 && b.height > 0)
    .map((b) => ({ w: b.width, h: b.height })), selector);
}

async function expectTargets(page: Page, selector: string, min: number): Promise<void> {
  const sizes = await targetSizes(page, selector);
  expect(sizes.length, `${selector} is on screen`).toBeGreaterThan(0);
  for (const s of sizes) {
    expect(s.w, `${selector} width`).toBeGreaterThanOrEqual(min);
    expect(s.h, `${selector} height`).toBeGreaterThanOrEqual(min);
  }
}

test.describe('target size', () => {
  test.slow();

  test('small inline controls are at least 24 px at 1366x768', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await openDense(page);
    await showWorkspaceMode(page, 'data');
    for (const sel of ['.olv-add-dataset-row', '.olv-layer-solo', '.olv-layer-lock', '.olv-layer-x']) await expectTargets(page, sel, 24);
    await showWorkspaceMode(page, 'analyse');
    // Run terrain analysis, Prepare terrain and the other remedies.
    await expect(page.locator('.olv-ah-remedy', { hasText: 'Run terrain analysis' })).toBeVisible();
    await expect(page.locator('.olv-ah-remedy', { hasText: 'Prepare terrain' }).first()).toBeVisible();
    await expectTargets(page, '.olv-ah-remedy', 24);
    await page.locator('.olv-ah-row[data-analysis="terrain"] .olv-ah-open').click();
    await expectTargets(page, '.olv-analyse-run', 24);
    await page.locator('.olv-analyse-run').click();
    await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 30_000 });
    await expectTargets(page, '.olv-analyse-surface-dl', 24);
  });

  test.describe('touch layout', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('the same controls are at least 44 px', async ({ page }) => {
      await openDense(page);
      await expect(page.locator('.olv-mobile-sheet')).toBeVisible({ timeout: 10_000 });
      await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="data"]').click();
      for (const sel of ['.olv-add-dataset-row', '.olv-layer-solo', '.olv-layer-lock', '.olv-layer-x']) await expectTargets(page, sel, 44);
      await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="analyse"]').click();
      await expectTargets(page, '.olv-msheet-slot[data-tab="analyse"] .olv-ah-remedy', 44);
      await page.locator('.olv-msheet-slot[data-tab="analyse"] .olv-ah-row[data-analysis="terrain"] .olv-ah-open').click();
      await page.locator('.olv-msheet-slot[data-tab="analyse"] .olv-analyse-run').click();
      await expect(page.locator('.olv-msheet-slot[data-tab="analyse"] .olv-fit-verdict-text')).toBeVisible({ timeout: 30_000 });
      await expectTargets(page, '.olv-msheet-slot[data-tab="analyse"] .olv-analyse-surface-dl', 44);
    });
  });
});
