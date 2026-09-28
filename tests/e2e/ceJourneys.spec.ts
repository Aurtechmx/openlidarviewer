/**
 * Wayfinding journeys J1 to J7 (spec CE-1, section 11.4), recorded.
 *
 * Each journey drives the viewer the way a user would, through visible
 * controls, and a recorder counts clicks, surface switches, Back and Escape
 * presses and the time to the journey's success signal. Clicks and surface
 * switches are the primary metrics: they depend only on the route taken.
 * Time is informational.
 *
 * Opening a fixture and placing measurement points go through the existing
 * test seams (a file drop, `__OLV_TEST_API__`). A point placed through the
 * seam counts as one canvas click, which is what a user spends on it.
 *
 * The journeys always run and assert their success signal. They write the
 * baseline only when OLV_CE_METRICS names an output file:
 *   OLV_CE_METRICS=docs/ux/metrics/ce-c0.json npx playwright test ceJourneys --project=deterministic --workers=1
 * One worker, so a single run collects every journey into one file.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dropDenseGridPly, dropTerrainAccessUtmLas, dropTinyPtx } from './helpers';
import { JourneyLog, type JourneyResult, type StepKind, type SurfaceState } from './journeyMetrics';

const OUT = process.env.OLV_CE_METRICS;
const results: JourneyResult[] = [];

const DESKTOP = { name: '1440x900', width: 1440, height: 900, touch: false } as const;
const PHONE = { name: '390x844', width: 390, height: 844, touch: true } as const;
type Viewport = typeof DESKTOP | typeof PHONE;

/** Read where the user is from the DOM. Presentation only; nothing is changed. */
async function readSurface(page: Page): Promise<SurfaceState> {
  return page.evaluate(() => {
    const vis = (e: Element | null): e is HTMLElement => {
      if (!e) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    const sheetTab = document.querySelector('.olv-mobile-sheet .olv-msheet-tab[aria-selected="true"]');
    const railTab = document.querySelector('.olv-ws-tab[aria-selected="true"]');
    const mode = (vis(document.querySelector('.olv-mobile-sheet')) ? sheetTab?.getAttribute('data-tab') : railTab?.getAttribute('data-mode')) ?? '';
    const title = Array.from(document.querySelectorAll('.olv-ws-mode.is-active .olv-ws-task-title')).find((t) => !t.closest('[hidden]') && t.textContent);
    const modal = Array.from(document.querySelectorAll('.olv-modal-title')).find(vis);
    const studio = Array.from(document.querySelectorAll('.olv-cs-host')).find((h) => vis(h) && h.childElementCount > 0);
    const bench = Array.from(document.querySelectorAll('.olv-workbench')).find(vis);
    return {
      mode,
      page: title?.textContent?.trim() || 'home',
      modal: modal?.textContent?.trim() ?? '',
      workspace: studio ? 'Contour Studio' : bench ? 'Profile Workbench' : '',
      palette: vis(document.querySelector('.olv-palette')),
    };
  });
}

/** Drives one journey and keeps its log. */
class Recorder {
  private log!: JourneyLog;
  private readonly page: Page;
  private readonly id: string;
  private readonly vp: Viewport;
  constructor(page: Page, id: string, vp: Viewport) {
    this.page = page;
    this.id = id;
    this.vp = vp;
  }

  async start(): Promise<void> {
    this.log = new JourneyLog(this.id, this.vp.name, await readSurface(this.page), performance.now());
  }

  private async after(kind: StepKind, note: string): Promise<void> {
    await this.page.waitForTimeout(150); // let a route change or a sheet move settle
    this.log.record(kind, note, await readSurface(this.page));
  }

  async click(target: Locator, note: string): Promise<void> {
    await target.click();
    await this.after('click', note);
  }

  async back(target: Locator, note: string): Promise<void> {
    await target.click();
    await this.after('back', note);
  }

  async key(key: string, note: string): Promise<void> {
    await this.page.keyboard.press(key);
    await this.after(key === 'Escape' ? 'escape' : 'key', note);
  }

  async type(target: Locator, value: string, note: string): Promise<void> {
    await target.fill(value);
    await this.after('type', note);
  }

  /** A measurement point, placed through the seam: one canvas click each. */
  async canvasPoints(points: Array<{ x: number; y: number; z: number }>, note: string): Promise<void> {
    for (const p of points) {
      await this.page.evaluate((pt) => {
        const api = (window as unknown as { __OLV_TEST_API__?: { placeMeasurementPoint: (q: typeof pt) => void } }).__OLV_TEST_API__;
        if (!api) throw new Error('__OLV_TEST_API__ not mounted');
        api.placeMeasurementPoint(pt);
      }, p);
      await this.after('canvas', note);
    }
  }

  /** A real click on a canvas (a lab grid), counted as a canvas click. */
  async canvasClick(target: Locator, position: { x: number; y: number }, note: string): Promise<void> {
    await target.click({ position });
    await this.after('canvas', note);
  }

  fact(name: string, value: string | number | boolean | null): void {
    this.log.facts[name] = value;
  }

  succeed(): void {
    this.log.succeed(performance.now());
  }

  finish(): JourneyResult {
    const r = this.log.result();
    results.push(r);
    return r;
  }
}

async function openPage(page: Page, vp: Viewport, drop: (p: Page) => Promise<void>): Promise<void> {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto('/?test=1');
  await drop(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await page.waitForTimeout(1_000); // the test API mounts on viewerLoaded
  if (vp.touch) await expect(page.locator('.olv-mobile-sheet')).toBeVisible({ timeout: 10_000 });
}

/** The control that opens a mode: the rail tab, or the phone-sheet tab. */
const modeTab = (page: Page, vp: Viewport, mode: string): Locator =>
  vp.touch
    ? page.locator(`.olv-mobile-sheet .olv-msheet-tab[data-tab="${mode}"]`)
    : page.locator(`.olv-ws-tab[data-mode="${mode}"]`);

/** Scope for rail content: the rail on desktop, the sheet slot on the phone. */
const modeScope = (page: Page, vp: Viewport, mode: string): Locator =>
  vp.touch ? page.locator(`.olv-msheet-slot[data-tab="${mode}"]`) : page.locator(`#olv-ws-mode-${mode}`);

/**
 * A lab row that needs a terrain run offers a remedy. Follow it the way a
 * first-time user would: the remedy, Run on the Terrain page, then Back.
 */
async function prepareTerrainIfAsked(rec: Recorder, page: Page, row: Locator): Promise<void> {
  const remedy = row.locator('.olv-ah-remedy').first();
  rec.fact('statusAtStart', (await row.locator('.olv-ah-badge').innerText()).trim());
  if (!(await remedy.isVisible())) return;
  rec.fact('remedy', (await remedy.innerText()).trim());
  await rec.click(remedy, 'Remedy');
  await rec.click(page.locator('.olv-analyse-run'), 'Run terrain analysis');
  await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 60_000 });
  await rec.back(page.locator('#olv-ws-mode-analyse .olv-ws-back'), 'Back (← Analyse)');
}

async function j1(page: Page, vp: Viewport, id: string): Promise<void> {
  await openPage(page, vp, dropDenseGridPly);
  const rec = new Recorder(page, id, vp);
  await rec.start();
  await rec.click(modeTab(page, vp, 'work'), 'Tools tab');
  await rec.click(modeScope(page, vp, 'work').locator('.olv-tool-launcher .olv-tl-row', { hasText: 'Measure' }).first(), 'Measure');
  await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: { setMeasureKind: (k: string) => void } }).__OLV_TEST_API__.setMeasureKind('distance'));
  await rec.canvasPoints([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], 'distance point');
  const row = page.locator('.olv-mp-row').first();
  // On the phone, starting a tool lowers the sheet to peek so the scene is
  // free; reading the value then needs the sheet raised again.
  if (vp.touch && !(await row.isVisible())) {
    rec.fact('sheetLoweredOnToolStart', true);
    await rec.click(page.locator('.olv-msheet-handle'), 'Expand panel (sheet handle)');
  }
  await expect(row).toBeVisible({ timeout: 5_000 });
  await expect(row).toContainText(/\d\s?(m|ft|units?)\b/);
  rec.succeed();
  rec.fact('valueText', (await row.innerText()).replace(/\s+/g, ' ').trim().slice(0, 80));
  rec.finish();
}

async function j3(page: Page, vp: Viewport, id: string): Promise<void> {
  await openPage(page, vp, dropTinyPtx);
  const rec = new Recorder(page, id, vp);
  await rec.start();
  await rec.click(modeTab(page, vp, 'analyse'), 'Analyse tab');
  await rec.click(modeScope(page, vp, 'analyse').locator('.olv-ah-row[data-analysis="observatory"] .olv-ah-open'), 'Observatory row');
  const modal = page.locator('.olv-modal');
  await expect(page.locator('.olv-modal-title')).toHaveText('Observatory');
  const run = modal.locator('.olv-observatory-run');
  if (!(await modal.locator('.olv-observatory-state-counts').isVisible())) await rec.click(run, 'Run Observatory');
  await expect(modal.locator('.olv-observatory-state-counts')).toContainText(/SURFACE: \d+/, { timeout: 30_000 });
  rec.fact('labRan', true);
  // Leave by the visible close control, the one labelled way out of the lab.
  await rec.back(modal.locator('.olv-modal-x'), 'Close dialog (×)');
  await expect(modal).toHaveCount(0);
  await rec.click(modeTab(page, vp, 'work'), 'Tools tab');
  await rec.click(modeScope(page, vp, 'work').locator('.olv-tool-launcher .olv-tl-row', { hasText: 'Measure' }).first(), 'Measure');
  await expect(modeScope(page, vp, 'work').locator('.olv-ws-task-title')).toHaveText('Measure');
  rec.succeed();
  rec.finish();
}

test.describe('CE wayfinding journeys', () => {
  test.slow();

  test.afterAll(() => {
    if (!OUT) return;
    const doc = {
      spec: 'docs/ux/COMMUNITY_SPEC.md section 11.4',
      // The phase is the file's own name: ce-c1.json records C1.
      phase: (/ce-(\w+)\.json$/.exec(OUT)?.[1] ?? 'c0').toUpperCase(),
      project: 'deterministic',
      primaryMetrics: ['clicks', 'surfaceSwitches'],
      informationalMetrics: ['timeToSuccessMs'],
      notes: [
        'Clicks and surface switches depend only on the route and are the same on every machine.',
        'timeToSuccessMs depends on the machine and build and is informational only.',
        'A measurement point placed through the test seam counts as one canvas click.',
        'A surface is the active mode, its page, and any open modal, workspace or palette.',
      ],
      journeys: results,
    };
    writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  });

  test('J1 first open to first measurement', async ({ page }) => {
    await j1(page, DESKTOP, 'J1');
  });

  test('J2 measurement to export', async ({ page }) => {
    await openPage(page, DESKTOP, dropDenseGridPly);
    await page.locator('.olv-ws-tab[data-mode="work"]').click();
    await page.locator('#olv-ws-mode-work .olv-tool-launcher .olv-tl-row', { hasText: 'Measure' }).first().click();
    await page.evaluate(() => {
      const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind: (k: string) => void; placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void } }).__OLV_TEST_API__;
      api.setMeasureKind('distance');
      api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
      api.placeMeasurementPoint({ x: 1, y: 0, z: 0 });
    });
    await expect(page.locator('.olv-mp-row')).toHaveCount(1);
    // Start from the finished measurement: the user has moved on to the Data mode.
    await page.locator('.olv-ws-tab[data-mode="data"]').click();
    const rec = new Recorder(page, 'J2', DESKTOP);
    await rec.start();
    await rec.click(page.locator('.olv-ws-tab[data-mode="work"]'), 'Tools tab');
    const download = page.waitForEvent('download');
    await rec.click(page.locator('.olv-mp-action', { hasText: /^Export session$/ }), 'Export session (Measure panel)');
    const file = await download;
    rec.succeed();
    rec.fact('file', file.suggestedFilename().replace(/^.*\./, '*.'));
    rec.fact('landedOnMeasure', (await page.locator('#olv-ws-mode-work .olv-ws-task-title').textContent()) === 'Measure');
    rec.finish();
  });

  test('J3 lab and back', async ({ page }) => {
    await j3(page, DESKTOP, 'J3');
  });

  test('J4 recover orientation with the rail collapsed and a workspace open', async ({ page }) => {
    await openPage(page, DESKTOP, dropDenseGridPly);
    // Set up: terrain run, Contours page, Contour Studio open, then the rail collapsed.
    await page.locator('.olv-ws-tab[data-mode="analyse"]').click();
    await page.locator('.olv-ah-row[data-analysis="terrain"] .olv-ah-open').click();
    await page.locator('.olv-analyse-run').click();
    await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 60_000 });
    await page.locator('.olv-at-link', { hasText: 'Contours' }).click();
    await page.locator('.olv-analyse-contour-launcher .olv-contour-launcher-action').click();
    await expect(page.locator('.olv-cs-export-btn', { hasText: /^GeoJSON$/ })).toBeVisible({ timeout: 30_000 });
    await page.locator('.olv-rail-tab').click();
    await expect(page.locator('#olv-left-panels')).toHaveClass(/olv-rail-collapsed/);

    const rec = new Recorder(page, 'J4', DESKTOP);
    await rec.start();
    // Can the location be read without touching the rail? Look for any visible
    // text outside the rail that names the page or the workspace.
    const readable = await page.evaluate(() => {
      const rail = document.querySelector('#olv-left-panels');
      const hit = Array.from(document.querySelectorAll('body *')).find((e) => {
        if (rail?.contains(e) || e.children.length) return false;
        // Tooltip text is not a location: a user cannot read it without hovering.
        if (e.closest('.olv-tip-layer, [role="tooltip"], [aria-hidden="true"]')) return false;
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return /\b(Contours|Contour Studio)\b/.test(e.textContent ?? '');
      });
      return hit ? `${hit.className}: ${(hit.textContent ?? '').trim().slice(0, 60)}` : '';
    });
    rec.fact('locationReadableWithoutRail', readable !== '');
    rec.fact('locationTextFound', readable || null);
    let railInteractions = 0;
    await rec.click(page.locator('.olv-rail-tab'), 'Expand the rail');
    railInteractions += 1;
    const back = page.locator('#olv-ws-mode-analyse .olv-ws-back');
    let backs = 0;
    while (await back.isVisible()) {
      await rec.back(back, `Back (${await back.innerText()})`);
      backs += 1;
      railInteractions += 1;
    }
    await expect(page.locator('#olv-ws-mode-analyse .olv-analyse-home')).toBeVisible();
    rec.succeed();
    rec.fact('railInteractions', railInteractions);
    rec.fact('backLabels', backs);
    rec.fact('succeedsWithoutRail', false);
    rec.finish();
  });

  test('J5 trust check on a scan with no vertical reference', async ({ page }) => {
    // dense-grid.ply declares no CRS, so its vertical reference is unknown.
    await openPage(page, DESKTOP, dropDenseGridPly);
    const rec = new Recorder(page, 'J5', DESKTOP);
    await rec.start();
    const row = page.locator('.olv-inspector .olv-layerhealth-card', { hasText: 'Vertical datum' });
    if (!(await row.isVisible())) {
      const tab = page.locator('.olv-right-rail-tab');
      if (await page.locator('#olv-right-rail.olv-right-collapsed, .olv-right-rail.olv-right-collapsed').count()) await rec.click(tab, 'Expand the right rail');
    }
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText(/Vertical datum\s*not established/);
    rec.succeed();
    rec.fact('foundIn', 'Scan Intelligence (right rail), layer health card');
    rec.fact('visibleWithoutHover', true);
    rec.finish();
  });

  test('J6 phone: J1 at 390x844', async ({ page }) => {
    await j1(page, PHONE, 'J6-J1');
  });

  test('J6 phone: J3 at 390x844', async ({ page }) => {
    await j3(page, PHONE, 'J6-J3');
  });

  test('J7 first lab use: Flow Pulse from the Analyse home', async ({ page }) => {
    const home = page.locator('#olv-ws-mode-analyse');
    const modal = page.locator('.olv-modal');
    await openPage(page, DESKTOP, dropDenseGridPly);
    const rec = new Recorder(page, 'J7-flow-pulse', DESKTOP);
    await rec.start();
    await rec.click(page.locator('.olv-ws-tab[data-mode="analyse"]'), 'Analyse tab');
    await prepareTerrainIfAsked(rec, page, home.locator('.olv-ah-row[data-analysis="flow-pulse"]'));
    await rec.click(home.locator('.olv-ah-row[data-analysis="flow-pulse"] .olv-ah-open'), 'Flow Pulse row');
    await expect(modal.locator('.olv-story-card')).toContainText('D8 flow routing', { timeout: 30_000 });
    rec.succeed();
    rec.finish();
  });

  test('J7 first lab use: Terrain Access from the Analyse home', async ({ page }) => {
    const home = page.locator('#olv-ws-mode-analyse');
    const modal = page.locator('.olv-modal');
    await openPage(page, DESKTOP, dropTerrainAccessUtmLas);
    const rec = new Recorder(page, 'J7-terrain-access', DESKTOP);
    await rec.start();
    await rec.click(page.locator('.olv-ws-tab[data-mode="analyse"]'), 'Analyse tab');
    await prepareTerrainIfAsked(rec, page, home.locator('.olv-ah-row[data-analysis="terrain-access"]'));
    await rec.click(home.locator('.olv-ah-row[data-analysis="terrain-access"] .olv-ah-open'), 'Terrain Access row');
    await expect(modal.locator('.olv-ta-form')).toBeVisible({ timeout: 20_000 });
    const fields = modal.locator('input[type=text]');
    const values = ['Illustrative', '80', '80', '50', '0', '0'];
    for (let i = 0; i < values.length; i += 1) await rec.type(fields.nth(i), values[i], `profile field ${i + 1}`);
    await rec.click(modal.locator('.olv-ta-form-submit'), 'Apply profile');
    const grid = modal.locator('.olv-ta-grid-canvas');
    await expect(grid).toBeVisible({ timeout: 20_000 });
    await rec.click(modal.locator('.olv-ta-segmented-btn', { hasText: 'Set start' }), 'Set start');
    await rec.canvasClick(grid, { x: 4, y: 4 }, 'start cell');
    await rec.click(modal.locator('.olv-ta-segmented-btn', { hasText: 'Set goal' }), 'Set goal');
    await grid.focus();
    await rec.key('ArrowRight', 'move goal cursor');
    await rec.key('ArrowDown', 'move goal cursor');
    await rec.key('Enter', 'set goal');
    await rec.click(modal.locator('.olv-ta-run'), 'Run Terrain Access');
    await expect(modal.locator('.olv-ta-run-card')).toContainText('geometric traversability screening', { timeout: 20_000 });
    rec.succeed();
    rec.finish();
  });

  test('J7 first lab use: Observatory from the Analyse home', async ({ page }) => {
    const home = page.locator('#olv-ws-mode-analyse');
    const modal = page.locator('.olv-modal');
    await openPage(page, DESKTOP, dropTinyPtx);
    const rec = new Recorder(page, 'J7-observatory', DESKTOP);
    await rec.start();
    await rec.click(page.locator('.olv-ws-tab[data-mode="analyse"]'), 'Analyse tab');
    await rec.click(home.locator('.olv-ah-row[data-analysis="observatory"] .olv-ah-open'), 'Observatory row');
    await expect(page.locator('.olv-modal-title')).toHaveText('Observatory');
    if (!(await modal.locator('.olv-observatory-state-counts').isVisible())) await rec.click(modal.locator('.olv-observatory-run'), 'Run Observatory');
    await expect(modal.locator('.olv-observatory-state-counts')).toContainText(/SURFACE: \d+/, { timeout: 30_000 });
    rec.succeed();
    rec.finish();
  });
});
