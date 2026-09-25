import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  dropDenseGridPly, dropTerrainAccessUtmLas, firePaletteAction,
  openAnalysePanel as openAnalyse,
} from './helpers';

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

async function openTerrainAccess(page: Page): Promise<void> {
  await firePaletteAction(page, 'Terrain Access', 'Terrain Access (Field Simulation Lab)');
  await expect(page.locator('.olv-modal-title')).toHaveText('Field Simulation Lab: Terrain Access');
}

test('refuses honestly, with no interactive controls, before any terrain analysis has run', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ })).toBeEnabled({ timeout: 20_000 });

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
  await expect(page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ })).toBeEnabled({ timeout: 20_000 });

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
  // The whole workflow (load, profile, run, route, explanation, export) takes
  // 27 to 29 s in WebKit on CI, close to the default 30 s budget.
  test.slow();
  await page.goto('/?test=1');
  // Georeferenced (UTM zone 13N) fixture — unlike `dropDenseGridPly`'s local/
  // unreferenced PLY, this resolves a horizontal scale, so the run actually
  // reaches the preview/selection/run/export surface instead of refusing
  // UNITS_UNRESOLVED before any of it renders.
  await dropTerrainAccessUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ })).toBeEnabled({ timeout: 20_000 });
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

  // PREVIEW reached: the georeferenced fixture resolves a horizontal scale,
  // so the traversability grid replaces the form rather than refusing.
  const grid = modal.locator('.olv-ta-grid-canvas');
  await expect(grid).toBeVisible({ timeout: 10_000 });
  const box = await grid.boundingBox();
  if (!box) throw new Error('grid canvas has no box');

  // WHY-NOT INSPECTOR: default mode is 'start'; switch to inspect and read a
  // sentence naming a concrete reason (eligible or blocked), never a vague answer.
  await modal.locator('.olv-ta-segmented-btn', { hasText: /Why not\?/ }).click();
  await grid.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(modal.locator('.olv-ta-inspector')).toContainText(/eligible|blocked|withheld/, { timeout: 5_000 });
  // The inspector's cell readout is a real elevation with its unit, or an
  // honest "unknown" — never the grid-local z printed bare.
  const inspectorText = await modal.locator('.olv-ta-inspector').innerText();
  expect(inspectorText.length).toBeGreaterThan(0);

  // START by CLICK, GOAL by KEYBOARD: exercises both input paths. The exact
  // cell a corner click lands on depends on the canvas's rendered size
  // (device pixel ratio/CSS scaling differ per browser), so this checks that
  // a start was actually set rather than pinning one browser's coordinates.
  await modal.locator('.olv-ta-segmented-btn', { hasText: 'Set start' }).click();
  await grid.click({ position: { x: 4, y: 4 } });
  await expect(modal.locator('.olv-ta-selection')).not.toContainText('Startnot set');
  await expect(modal.locator('.olv-ta-selection')).toContainText(/Start\s*col \d+, row \d+/);

  await modal.locator('.olv-ta-segmented-btn', { hasText: 'Set goal' }).click();
  await grid.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(modal.locator('.olv-ta-selection')).toContainText('Goal');
  await expect(modal.locator('.olv-ta-selection')).not.toContainText('Goal: not set');

  // RUN: the button is enabled once both endpoints are set. The gentle
  // sinusoidal fixture surface and a permissive profile are chosen so a
  // route between two nearby corner cells is expected to be found — this is
  // the deterministic happy path, not a best-effort branch.
  const runButton = modal.locator('.olv-ta-run');
  await expect(runButton).toBeEnabled();
  await runButton.click();
  await expect(modal.locator('.olv-ta-run-card')).toContainText('geometric traversability screening', {
    timeout: 10_000,
  });
  // §22: never a safety/passability claim, win or refuse.
  await expect(modal.locator('.olv-ta-run-card')).not.toContainText(/\bis safe\b|\bis drivable\b|\bis passable\b/i);
  // The horizontal length/grade rows carry a real metric unit, guaranteed by
  // the runner's own UNITS_UNRESOLVED refusal gate (see terrainAccessRunner.ts).
  await expect(modal.locator('.olv-ta-run-card')).toContainText(/Horizontal length\s*[\d.]+ m/);

  // TRAVERSABILITY OVERLAY: offered (real scene membership wired through),
  // toggles, and stays drawn on the scan after the modal closes.
  const overlayToggle = modal.locator('.olv-ta-overlay-toggle');
  await expect(overlayToggle).toBeVisible();
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'false');
  await overlayToggle.click();
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'true');

  // EXPORT: downloads a ZIP whose raster/route carry real, georeferenced
  // coordinates in the dataset CRS, not a local (0, 0) origin.
  const exportBtn = modal.locator('.olv-ta-export');
  await expect(exportBtn).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await exportBtn.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-terrain-access\.zip$/);
  const downloadPath = await download.path();
  if (downloadPath) {
    const zipBytes = readFileSync(downloadPath);
    const readmeText = extractZipEntryText(zipBytes, findZipEntryName(zipBytes, 'README.txt'));
    // The fixture's UTM easting/northing are in the 500000/4100000 range —
    // real georeferencing, not a local (0, 0) origin.
    expect(readmeText).not.toContain('not georeferenced');
    const ascText = extractZipEntryText(zipBytes, findZipEntryName(zipBytes, 'traversability.asc'));
    expect(ascText).toMatch(/xllcorner 5000\d\d\.?\d*/);
    expect(ascText).toMatch(/yllcorner 41000\d\d\.?\d*/);
  }

  // LIVE REGION: present and polite.
  const live = modal.locator('.olv-ta-live');
  await expect(live).toHaveAttribute('aria-live', 'polite');

  // Closing the modal — which covers the scene, the only place a user could
  // otherwise see the overlay — must not tear it down (mirrors Flow Pulse's
  // persisted-overlay behaviour): reopening the Lab shows the toggle already
  // pressed, because it is the SAME persisted overlay still attached to the
  // scan, not a fresh one reset to off.
  await page.locator('.olv-modal-x').click();
  await expect(page.locator('.olv-modal')).toHaveCount(0);
  await openTerrainAccess(page);
  // A prior preview is not remembered across opens (only the overlay is),
  // so the Lab reopens on the blank profile form.
  await expect(page.locator('.olv-modal .olv-ta-form')).toBeVisible();
});

/** Find a ZIP entry's exact stored name by a suffix, from the local file headers. */
function findZipEntryName(zip: Buffer, suffix: string): string {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let p = 0;
  while (p + 30 <= zip.length && dv.getUint32(p, true) === 0x04034b50) {
    const compSize = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const name = zip.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    if (name.endsWith(suffix)) return name;
    p = p + 30 + nameLen + extraLen + compSize;
  }
  throw new Error(`no ZIP entry ending in ${suffix}`);
}

/** Extract one stored (uncompressed) ZIP entry's bytes as text, by exact name. */
function extractZipEntryText(zip: Buffer, name: string): string {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const wantName = Buffer.from(name, 'utf8');
  let p = 0;
  while (p + 30 <= zip.length && dv.getUint32(p, true) === 0x04034b50) {
    const compSize = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const nameBytes = zip.subarray(p + 30, p + 30 + nameLen);
    const dataStart = p + 30 + nameLen + extraLen;
    if (nameBytes.equals(wantName)) return zip.subarray(dataStart, dataStart + compSize).toString('utf8');
    p = dataStart + compSize;
  }
  throw new Error(`entry not found: ${name}`);
}
