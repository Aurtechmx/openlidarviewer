import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dropDenseGridPly, openAnalysePage, openAnalysePanel } from './helpers';
import { extractEntry } from '../helpers/zipReader';

/**
 * Analyse panel (v0.4.0) — the conservative surface for terrain readiness
 * and contour export. It is a post-scan tool: hidden until a scan loads,
 * revealed (collapsed) on load, and re-hidden when the scan is closed.
 * These specs guard the honesty contract from the hardening spec:
 *   - it stays hidden in the empty state (no clutter before a scan);
 *   - after a scan + run it surfaces readiness, recommended grid/interval,
 *     coverage, and status chips;
 *   - a minimal "Planned" tag row sets expectations (quiet tags, no dead
 *     buttons);
 *   - export is disabled when the DTM quality gate blocks it.
 *
 * Runs against the dev server (see playwright.config.ts); the scan-loading
 * specs need a real WebGL/WebGPU context and won't run in a GPU-less sandbox.
 */

async function openAnalyse(page: Page): Promise<void> {
  await openAnalysePanel(page);
}

test('stays hidden in the empty state before any scan is loaded', async ({ page }) => {
  await page.goto('/');
  // The empty state is shown…
  await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });
  // …and the Analyse panel is a post-scan tool, so it is not shown yet.
  await expect(page.locator('.olv-analyse-panel')).toBeHidden();
});

test('shows a minimal "Planned" tag row, with no dead buttons', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openAnalyse(page);
  // The planned tags sit in the Method disclosure: how the analysis works.
  await page.locator('.olv-analyse-method-summary').click();
  // Quiet planned-capability tags; no verbose itemised cards.
  await expect(page.locator('.olv-analyse-plan-tag').first()).toBeVisible();
  expect(await page.locator('.olv-analyse-plan-tag').count()).toBeGreaterThan(0);
  expect(await page.locator('.olv-analyse-road-card').count()).toBe(0);
  // The planned area has no buttons or links — no clickable dead ends.
  expect(await page.locator('.olv-analyse-roadmap button, .olv-analyse-roadmap a').count()).toBe(0);
});

test('the Analyse dock button re-opens the panel after it is closed', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openAnalyse(page);

  const panel = page.locator('.olv-analyse-panel');
  const analyseBtn = page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ });
  await expect(analyseBtn).toBeEnabled();

  // Toggle it closed, then re-open it with the dock button — the recovery path.
  await analyseBtn.click();
  await expect(panel).toBeHidden();
  await analyseBtn.click();
  await expect(panel).toBeVisible();
});

test('after running on a scan: readiness, chips, recommendations, and gated export appear', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await openAnalyse(page);

  await page.locator('.olv-analyse-run').click();
  // Readiness cards render (3 of them) — they live in the collapsed Details
  // expander, so assert on count (DOM presence), not visibility.
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, {
    timeout: 20_000,
  });

  // The Data Fitness scorecard leads: one plain-language verdict + the six
  // traffic-light dimension rows (each a metaphor icon + label + tone glyph).
  const verdict = page.locator('.olv-fit-verdict-text');
  await expect(verdict).toBeVisible();
  await expect(verdict).toContainText(/Ready|Usable|Limited|Preview|Not usable|streaming/i);
  expect(await page.locator('.olv-fit-row').count()).toBe(6);
  // Georeferencing is the scorecard's "Location & height" row (it replaced the
  // old jargon CRS/Datum chips).
  await expect(page.locator('.olv-fit-label', { hasText: 'Location & height' })).toBeVisible();

  // Detailed metrics and the surface models are behind the Evidence expander.
  await page.locator('.olv-analyse-details-summary').click();
  // Composite terrain quality score: a single 0–100 number (the exact score now
  // lives here, demoted out of the hero; the per-dimension breakdown is the
  // scorecard above, so the old weighted bars are gone).
  await expect(page.locator('.olv-analyse-score-num')).toBeVisible();
  await expect(page.locator('.olv-analyse-score-num')).toHaveText(/^~?\d{1,3}$/);
  expect(await page.locator('.olv-analyse-score-comp').count()).toBe(0);
  // The status-chip row was retired in the de-dup: scan scope is the scorecard's
  // Integrity row, export is the always-visible Export-readiness line, and the
  // DTM gate is the verdict tier — so the chips no longer duplicate them.
  expect(await page.locator('.olv-analyse-chip').count()).toBe(0);

  // Surface models (inside Evidence): stats + raster preview tiles (canopy
  // height + relief), each with a click-to-sample readout and PNG export.
  await expect(page.locator('.olv-analyse-surface-stat').first()).toContainText(/height|Slope/i);
  await expect(page.locator('canvas.olv-analyse-raster').first()).toBeVisible();
  await expect(page.locator('.olv-analyse-relief-toggle')).toContainText(/Multi-directional/i);
  await expect(page.locator('.olv-analyse-sample').first()).toBeVisible();
  await expect(page.locator('.olv-analyse-surface-dl').first()).toContainText(/Export PNG/i);
  // The grid and interval recommendation are WITHHELD here, and the row says
  // why: the dropped PLY carries no CRS, the ladders are metre ladders, and a
  // recommendation sized from raw coordinates was the defect. This spec used to
  // expect "Recommended grid: N m" on that scan, which the analysis produced
  // only because the live path handed it a placeholder scale of 1 and it read
  // that as a resolved unit. The resolved case is covered by the runner-level
  // unit test with a metre CRS.
  await expect(page.locator('.olv-analyse-reco', { hasText: /No grid recommendation/i })).toBeVisible();
  await expect(page.locator('.olv-analyse-reco', { hasText: /Recommended grid/i })).toHaveCount(0);
  await expect(page.locator('.olv-analyse-reco', { hasText: /contour interval/i })).toHaveCount(0);

  // Export gating (v0.5.9): the export controls no longer sit inline. They are
  // the Contour Studio workspace's export bar, mounted inside the gated
  // `.olv-analyse-contour-deliverable` container, which starts `olv-hidden` and
  // is revealed only when the Terrain Products launcher's action fires. The
  // launcher mounts lazily (a dynamic chunk) once the analysis completes, so
  // wait for its action button, then click it to open the deliverable. For this
  // synthetic scan (coverage but no CRS) the launch state is `exploratory`, so
  // the action reads "Create Exploratory Contours" and the revealed export
  // buttons stay enabled — only an `unavailable` state disables them (that path
  // is unit-tested). The retired inline `.olv-analyse-dl` row still exists as a
  // set of DETACHED backing click-targets the workspace dispatches to, so it is
  // no longer asserted on here.
  // Contour Studio is on the Contours page, under Terrain.
  await openAnalysePage(page, 'contours');
  const launch = page.locator('.olv-analyse-contour-launcher .olv-contour-launcher-action');
  await expect(launch).toBeVisible({ timeout: 20_000 });
  await expect(launch).toBeEnabled();
  await launch.click();
  // The gated deliverable is revealed (loses `olv-hidden`), surfacing the real
  // shipped export surface — the workspace `.olv-cs-export-btn` bar.
  await expect(page.locator('.olv-analyse-contour-deliverable')).not.toHaveClass(/olv-hidden/);

  // Vector export: the GeoJSON button is visible and (exploratory ⇒ not blocked)
  // enabled.
  const geojson = page.locator('.olv-cs-export-btn', { hasText: /^GeoJSON$/ });
  await expect(geojson).toBeVisible();
  await expect(geojson).toBeEnabled();
  // The printable map-sheet export is the "Map sheet → PDF" button, offered
  // alongside the vector formats (it opens the pre-export dialog via the panel's
  // backing map-PDF target).
  const mapPdf = page.locator('.olv-cs-export-btn', { hasText: /^PDF$/ });
  await expect(mapPdf).toBeVisible();
  await expect(mapPdf).toBeEnabled();
  // The "not survey-grade" honesty caveat must be visible. When BOTH the DEM and
  // contour-preview caveats apply, P12 consolidates them into ONE banner
  // (`.olv-analyse-dem-note`, which lives inside the now-revealed deliverable)
  // and leaves the standalone contour note empty; when only the contour caveat
  // applies it stays in `.olv-analyse-export-note`. Assert the disclosure
  // wherever the consolidation places it.
  await expect(
    page
      .locator('.olv-analyse-export-note, .olv-analyse-dem-note')
      .filter({ hasText: /not survey-grade/i }),
  ).toBeVisible();
  // The DEM raster package is offered as the primary data-package export and
  // stays enabled regardless of the contour gate (a bare-earth raster is valid
  // either way).
  const dem = page.locator('.olv-cs-export-btn', { hasText: /^DEM \(ZIP\)$/ });
  await expect(dem).toBeVisible();
  await expect(dem).toBeEnabled();
  // The complete deliverable bundle ("Complete (ZIP)") — the purpose-aware
  // curated package — is offered and, exploratory ⇒ enabled (it watermarks
  // rather than blocks). Its per-purpose geometry + provenance stamps are
  // unit-covered in tests/demExport.test.ts; this pins the shipped button.
  const complete = page.locator('.olv-cs-export-btn', { hasText: /^Complete \(ZIP\)$/ });
  await expect(complete).toBeVisible();
  await expect(complete).toBeEnabled();
});

/**
 * The dense-grid surface as a LAS 1.4 in EPSG:32633 with a NAVD88 metre
 * vertical axis, so the vertical unit resolves and the tier can reach T3.
 */
async function dropDenseGridUtmLas(page: Page): Promise<void> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
  };
  const { writeLas14 } = await import('../../src/convert/writeLas');
  const { wktForEpsg } = await import('../../src/io/epsgWkt');
  const N = 60;
  const x = new Float64Array(N * N);
  const y = new Float64Array(N * N);
  const z = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) {
    const u = Math.floor(k / N) / (N - 1);
    const v = (k % N) / (N - 1);
    x[k] = 500_000 + u * 10;
    y[k] = 5_000_000 + v * 10;
    z[k] = 200 + Math.sin(u * Math.PI) * Math.cos(v * Math.PI) * 1.5;
  }
  const bytes = writeLas14({ count: N * N, x, y, z }, {
    wkt: wktForEpsg(32633), epsg: 32633, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9001,
  });
  const dt = await page.evaluateHandle((b) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(b)], 'dense-grid-utm.las'));
    return d;
  }, [...bytes]);
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

/** Load a scan, run the analysis, open Contour Studio and return a DEM download helper. */
async function openDemExport(page: Page, drop: (page: Page) => Promise<void>) {
  await page.goto('/?test=1');
  await drop(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await openAnalyse(page);
  await page.locator('.olv-analyse-run').click();
  const launch = page.locator('.olv-analyse-contour-launcher .olv-contour-launcher-action');
  await expect(launch).toBeVisible({ timeout: 20_000 });
  await launch.click();
  const dem = page.locator('.olv-cs-export-btn', { hasText: /^DEM \(ZIP\)$/ });
  return async (): Promise<{ zip: Uint8Array; entry: (suffix: string) => Uint8Array | null }> => {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dem.click()]);
    const zip = new Uint8Array(readFileSync((await download.path())!));
    // The package names every file after the scan; the DTM GeoTIFF is always there.
    const m = /([A-Za-z0-9._-]+)-dtm\.tif/.exec(new TextDecoder('latin1').decode(zip));
    expect(m, 'the DTM GeoTIFF is in the package').not.toBeNull();
    return { zip, entry: (suffix) => extractEntry(zip, `${m![1]}${suffix}`) };
  };
}

test('the DEM package carries the sensitivity and attention rasters only when their options are checked', async ({ page }) => {
  test.setTimeout(120_000);
  const download = await openDemExport(page, dropDenseGridPly);

  const include = page.getByRole('checkbox', { name: 'Include sensitivity' });
  const attention = page.getByRole('checkbox', { name: 'Include attention' });
  await expect(include).toBeVisible();
  await expect(include).not.toBeChecked();
  await expect(attention).not.toBeChecked();
  const box = page.locator('.olv-analyse-dem-sensitivity');
  await expect(box).toContainText('Members that match the canonical settings add no spread.');
  await expect(box).toContainText('Level 0 means no reason was found');

  const off = await download();
  expect(off.entry('_sensitivity.tif')).toBeNull();
  expect(off.entry('_attention.tif')).toBeNull();

  await include.check();
  const on = await download();
  expect(on.entry('_sensitivity.tif')).not.toBeNull();
  expect(on.entry('_attention.tif')).toBeNull();

  await include.uncheck();
  await attention.check();
  const att = await download();
  expect(att.entry('_attention.tif')).not.toBeNull();
  expect(att.entry('_sensitivity.tif')).toBeNull();
});

test('a DEM package with both sensitivity and attention on a projected scan is tier T3', async ({ page }) => {
  test.setTimeout(120_000);
  // The dense PLY has no CRS, so its vertical unit is unresolved and the tier stops at T2.
  const download = await openDemExport(page, dropDenseGridUtmLas);
  await page.getByRole('checkbox', { name: 'Include sensitivity' }).check();
  await page.getByRole('checkbox', { name: 'Include attention' }).check();
  const both = await download();
  const passport = both.entry('-dtm.tif.olv-passport.json');
  expect(passport).not.toBeNull();
  expect(JSON.parse(new TextDecoder().decode(passport!)).demEvidence.tier).toBe('T3');
});
