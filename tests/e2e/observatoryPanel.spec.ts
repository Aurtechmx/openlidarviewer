/**
 * Observatory panel — opens on a real scan with a declared station (the
 * repo's PTX fixture, `dropTinyPtx`, one scanner setup at the origin), runs
 * the Observatory, shows Evidence/Shadow state counts, and — the exact
 * lesson #1014 (contour layer lifetime) already paid for — the shadow-voxel
 * overlay must not outlive the scan it was drawn from.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, dropTinyPtx, showWorkspaceMode } from './helpers';

async function firePaletteAction(page: Page, query: string, rowText: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill(query);
  const row = page.locator('.olv-palette-row', { hasText: rowText }).first();
  await expect(row).toBeVisible();
  // The row itself: a Go to entry for the same page can rank first.
  await row.click();
  await expect(page.locator('.olv-palette')).toBeHidden();
}

async function openObservatory(page: Page): Promise<void> {
  await firePaletteAction(page, 'Observatory', 'Observatory (observation evidence)');
  await expect(page.locator('.olv-analyse-page[data-page="observatory"]')).toBeVisible();
}

test.describe('Observatory panel', () => {
  test.slow();

  test('shows Sources/Evidence/Shadow/Planning/Record for a scan with a declared station', async ({ page }) => {
    await page.goto('/?test=1');
    await dropTinyPtx(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    await showWorkspaceMode(page, 'analyse');
    await openObservatory(page);

    const labPage = page.locator('.olv-analyse-page[data-page="observatory"]');
    const sections = labPage.locator('.olv-observatory-section-title');
    await expect(sections).toHaveText(['Sources', 'Evidence', 'Shadow', 'Planning', 'Record'], { timeout: 20_000 });

    // The single declared PTX station shows a DECLARED ORIGIN badge, never
    // ASSUMED — the fixture's own header declares a real pose.
    await expect(labPage.locator('.olv-observatory-station-row')).toContainText('DECLARED ORIGIN');
    // The 3D marker key names both glyphs, so the scene markers have a text legend.
    await expect(labPage.locator('.olv-observatory-marker-key')).toContainText('hollow dashed orange ring');
    // OB-PR-02: the slice plane has a level control and a glyph legend once drawn.
    await expect(labPage.locator('.olv-observatory-slice-level')).toBeVisible();
    await expect(labPage.locator('.olv-observatory-slice-legend')).toContainText('▲ Shadowed');
    // Evidence lists every state, including a real count for at least one.
    await expect(labPage.locator('.olv-observatory-state-counts')).toContainText(/SURFACE: \d+/);
    // Planning shows the Coverage Gain result, labelled preview on a
    // resident-only field, with the instrument model it ran under.
    const planning = labPage.locator('.olv-observatory-planning');
    await expect(planning).toContainText('Authority: preview (basis resident-only)');
    await expect(planning).toContainText('Instrument model: height');
    await expect(planning).toContainText('Reachability is not checked');
    await expect(planning).not.toContainText('not implemented');
  });

  test('closing the scan removes the shadow overlay and leaves no stale panel state', async ({ page }) => {
    await page.goto('/?test=1');
    await dropTinyPtx(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    await showWorkspaceMode(page, 'analyse');
    await openObservatory(page);
    await expect(page.locator('.olv-observatory-section-title')).toHaveCount(5, { timeout: 20_000 });
    await page.keyboard.press('Escape'); // leave the page; the overlay (if drawn) stays in the scene

    await page.locator('.olv-tool-close').click();
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });

    // Reopening the Observatory on the now-empty state must never show the
    // closed scan's stations or state counts — the runner resets on scan
    // close (`abortAndClearCache`), same seam contours and Flow Pulse use.
    // The empty state has no workspace tabs to click; the palette action
    // itself calls `showAnalyseMode()`, so it is opened directly.
    // With no scan there is no workspace to hold the page, so it is a dialog.
    await firePaletteAction(page, 'Observatory', 'Observatory (observation evidence)');
    const labPage = page.locator('.olv-modal');
    await expect(labPage).not.toContainText('DECLARED ORIGIN');
    await expect(labPage.locator('.olv-observatory-status')).toBeVisible();
  });

  test('a scan with no scanner setups: the Analyse row is not Ready and the panel says what it needs', async ({ page }) => {
    const needs = 'Needs scanner setups (station positions), for example from PTX files.';
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    await showWorkspaceMode(page, 'analyse');
    const row = page.locator('.olv-ah-row[data-analysis="observatory"]');
    await expect(row.locator('.olv-ah-reason')).toHaveText(needs, { timeout: 20_000 });
    await expect(row.locator('.olv-ah-badge')).not.toHaveText('Ready');
    await expect(row.locator('.olv-ah-hint')).toContainText('what the scanner saw from each setup');

    await openObservatory(page);
    await expect(page.locator('.olv-analyse-page[data-page="observatory"] .olv-observatory-ineligible')).toHaveText(needs, { timeout: 20_000 });
  });
});
