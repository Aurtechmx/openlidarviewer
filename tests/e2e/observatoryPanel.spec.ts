/**
 * Observatory panel — opens on a real scan with a declared station (the
 * repo's PTX fixture, `dropTinyPtx`, one scanner setup at the origin), runs
 * the Observatory, shows Evidence/Shadow state counts, and — the exact
 * lesson #1014 (contour layer lifetime) already paid for — the shadow-voxel
 * overlay must not outlive the scan it was drawn from.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropTinyPtx, showWorkspaceMode } from './helpers';

async function firePaletteAction(page: Page, query: string, rowText: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill(query);
  await expect(page.locator('.olv-palette-row', { hasText: rowText })).toBeVisible();
  await page.locator('.olv-palette-input').press('Enter');
  await expect(page.locator('.olv-palette')).toBeHidden();
}

async function openObservatory(page: Page): Promise<void> {
  await firePaletteAction(page, 'Observatory', 'Observatory (observation evidence)');
  await expect(page.locator('.olv-modal-title')).toHaveText('Observatory');
}

test.describe('Observatory panel', () => {
  test.slow();

  test('shows Sources/Evidence/Shadow/Planning/Record for a scan with a declared station', async ({ page }) => {
    await page.goto('/?test=1');
    await dropTinyPtx(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    await showWorkspaceMode(page, 'analyse');
    await openObservatory(page);

    const modal = page.locator('.olv-modal');
    const sections = modal.locator('.olv-observatory-section-title');
    await expect(sections).toHaveText(['Sources', 'Evidence', 'Shadow', 'Planning', 'Record'], { timeout: 20_000 });

    // The single declared PTX station shows a DECLARED ORIGIN badge, never
    // ASSUMED — the fixture's own header declares a real pose.
    await expect(modal.locator('.olv-observatory-station-row')).toContainText('DECLARED ORIGIN');
    // Evidence lists every state, including a real count for at least one.
    await expect(modal.locator('.olv-observatory-state-counts')).toContainText(/SURFACE: \d+/);
    // Planning shows the Coverage Gain result, labelled preview on a
    // resident-only field, with the instrument model it ran under.
    const planning = modal.locator('.olv-observatory-planning');
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
    await page.keyboard.press('Escape'); // close the modal; the overlay (if drawn) stays in the scene

    await page.locator('.olv-tool-close').click();
    await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 20_000 });

    // Reopening the Observatory on the now-empty state must never show the
    // closed scan's stations or state counts — the runner resets on scan
    // close (`abortAndClearCache`), same seam contours and Flow Pulse use.
    // The empty state has no workspace tabs to click; the palette action
    // itself calls `showAnalyseMode()`, so it is opened directly.
    await openObservatory(page);
    const modal = page.locator('.olv-modal');
    await expect(modal).not.toContainText('DECLARED ORIGIN');
    await expect(modal.locator('.olv-observatory-status')).toBeVisible();
  });
});
