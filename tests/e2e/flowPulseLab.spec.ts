import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, firePaletteAction, openAnalysePanel as openAnalyse, closeScanFromDock, clickTaskBack } from './helpers';

/**
 * Flow Pulse (Field Simulation Lab) — run, switch conditioning, click-to-pulse
 * and catchment on the keyboard-/pointer-accessible result grid, the flow
 * accumulation overlay toggle, and the refusal states. The pure pieces (cell
 * math, the click honesty guard, the overlay buffers) are unit-tested;
 * this spec pins the real user surface, including real keyboard operation.
 *
 * Runs against the dev server (see playwright.config.ts); the scan-loading
 * specs need a real WebGL/WebGPU context.
 */

async function openFlowPulse(page: Page): Promise<void> {
  await firePaletteAction(page, 'Flow Pulse', 'Flow Pulse (Field Simulation Lab)');
  await expect(page.locator('.olv-analyse-page[data-page="flow-pulse"]')).toBeVisible();
}

/** Drop the fixture scan and run terrain analysis to readiness. */
async function loadScanAndAnalyse(page: Page): Promise<void> {
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  // The dock's Analyse tool enables once the scan is loaded and ready for
  // analysis actions — the actual app signal, in place of a fixed wait.
  await expect(page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ })).toBeEnabled({ timeout: 20_000 });
  await openAnalyse(page);
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, {
    timeout: 20_000,
  });
}

test('without a ground surface: one click runs terrain first on the lab page, then shows the map', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);

  // Record that the lab's own page showed progress while terrain ran.
  await page.evaluate(() => {
    const w = window as unknown as { __preparingSeen: boolean };
    w.__preparingSeen = false;
    const obs = new MutationObserver(() => {
      if (!document.querySelector('.olv-analyse-page[data-page="flow-pulse"] .olv-lab-preparing [role="status"]')) return;
      w.__preparingSeen = true;
      obs.disconnect();
    });
    obs.observe(document.body, { subtree: true, childList: true });
  });
  await openFlowPulse(page);
  const labPage = page.locator('.olv-analyse-page[data-page="flow-pulse"]');
  await expect(labPage.locator('.olv-flow-grid-canvas')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as { __preparingSeen: boolean }).__preparingSeen), 'progress showed on the lab page').toBe(true);
  // It never left for the Terrain page, so there is no way back to offer.
  await expect(page.locator('#olv-ws-mode-analyse .olv-ws-task-title')).toHaveText('Flow Pulse');
  await expect(page.locator('.olv-at-back')).toHaveCount(0);
  // The status chip leads, then the map; the checklist is inside the chip.
  expect(await labPage.evaluate((root) => {
    const chip = root.querySelector('.olv-lab-chip');
    const grid = root.querySelector('.olv-flow-grid-canvas');
    return !!chip && !!grid && !!(chip.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await expect(labPage.locator('.olv-lab-chip .olv-lab-ready[data-state="met"]')).toContainText('Ground surface (terrain run)');
  await expect(labPage.locator('.olv-story-card')).toContainText('D8 flow routing over the analysed DTM');
  // Purpose and stages are kept, folded into Details.
  await expect(labPage.locator('.olv-lab-purpose')).toBeHidden();
  await labPage.locator('.olv-lab-details > summary').click();
  await expect(labPage.locator('.olv-lab-purpose')).toContainText('Counts cells, not rainfall.');
  await expect(labPage.locator('.olv-lab-stages > .olv-lab-stage[aria-current="step"]')).toHaveText('3. Pick a cell');
});

test('run, conditioning, click-to-pulse, catchment, keyboard path, and the overlay toggle', async ({ page }) => {
  await page.goto('/?test=1');
  await loadScanAndAnalyse(page);

  await openFlowPulse(page);
  const labPage = page.locator('.olv-analyse-page[data-page="flow-pulse"]');

  // SUCCESS state: the run summary, naming the method it used.
  await expect(labPage.locator('.olv-story-card')).toContainText('D8 flow routing over the analysed DTM');
  await expect(labPage.locator('.olv-story-card')).toContainText('olv.simulation.terrain-flow.d8');

  // CONDITIONING: Priority-Flood is the default, both options offered, it is pressed.
  const rawBtn = labPage.locator('.olv-flow-cond-btn', { hasText: 'Raw terrain' });
  const floodBtn = labPage.locator('.olv-flow-cond-btn', { hasText: 'Priority-Flood conditioned' });
  await expect(floodBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(rawBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(labPage.locator('.olv-story-card')).toContainText('priority-flood');
  await expect(floodBtn).toHaveAttribute('data-tip', 'Fill closed hollows first, so most flow reaches an outlet; flats may remain.');
  await expect(labPage.locator('.olv-flow-cond-hint')).toContainText('Use Raw to see where water pools');

  // Switching conditioning re-runs the model: the pressed state flips and the
  // record's own method list no longer names Priority-Flood.
  await page.evaluate(() => {
    const w = window as unknown as { __emblemSeen: string | null };
    w.__emblemSeen = null;
    const obs = new MutationObserver(() => {
      const scan = document.querySelector('.olv-flow-busy .olv-busy-scan--emblem');
      if (!scan) return;
      w.__emblemSeen = scan.getAttribute('aria-hidden');
      obs.disconnect();
    });
    obs.observe(document.body, { subtree: true, childList: true });
  });
  await rawBtn.click();
  await expect(rawBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  await expect(floodBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(labPage.locator('.olv-story-card')).not.toContainText('priority-flood', { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __emblemSeen: string | null }).__emblemSeen), 'the emblem waited while it ran').toBe('true');
  await expect(labPage.locator('.olv-flow-busy')).toHaveCount(0);

  // CLICK-TO-PULSE via the keyboard-accessible result grid cursor (the
  // spec's own named alternative to a live-scan click — see FlowOverlay.ts
  // and flowResultGrid.ts for why). A click at the CENTRE of the raster lands
  // on the best-covered cell of this dense synthetic surface, so the mouse
  // path is exercised against a cell certain to trace.
  const grid = labPage.locator('.olv-flow-grid-canvas');
  await expect(grid).toBeVisible();
  const box = await grid.boundingBox();
  if (!box) throw new Error('grid canvas has no box');
  await expect(labPage.locator('.olv-flow-selection-empty')).toContainText('Click a cell on the map');
  await grid.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(labPage.locator('.olv-flow-selection')).toContainText('Path cells', { timeout: 5_000 });

  // KEYBOARD PATH: the click above also focused the canvas. Arrow keys move
  // the cursor (the status line names the new cell — proof keyboard
  // navigation itself works) and Enter activates it; a corner cell on this
  // fixture may or may not carry a measured elevation, so either a trace or
  // an honest refusal is accepted here — both are real, tested outcomes.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect(labPage.locator('.olv-flow-grid-status')).not.toContainText('Selected');
  await page.keyboard.press('Enter');
  await expect(labPage.locator('.olv-flow-selection')).toContainText(/Path cells|not drawn/, { timeout: 5_000 });

  // CATCHMENT: switch mode, activate the centre cell again, get a
  // contributing-cells readout.
  await labPage.locator('.olv-flow-mode-btn', { hasText: 'Set catchment outlet' }).click();
  await expect(labPage.locator('.olv-flow-selection-empty')).toContainText('the area that drains to it');
  await grid.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(labPage.locator('.olv-flow-selection')).toContainText('Contributing cells', { timeout: 5_000 });

  // EXPORT: the package button downloads a ZIP built from the current run,
  // including the path just traced above.
  const exportBtn = labPage.locator('.olv-flow-export');
  await expect(exportBtn).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await exportBtn.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-flow-pulse\.zip$/);

  // Switching conditioning re-runs the model and clears the trace and
  // catchment drawn above; the live region says so.
  await floodBtn.click();
  await expect(floodBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  await expect(labPage.locator('.olv-flow-live')).toHaveText('Flow Pulse run complete. The traced path and catchment were cleared.', { timeout: 10_000 });

  // ACCUMULATION OVERLAY: offered (the Analyse panel wired real scene
  // membership through to the Lab), on when the result opens, toggles, and
  // states its own honesty limit rather than implying discharge.
  const overlayToggle = labPage.locator('.olv-flow-overlay-toggle');
  await expect(overlayToggle).toBeVisible();
  await expect(labPage.locator('.olv-flow-overlay-legend')).toContainText('counts cells, not water');
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'true');
  await overlayToggle.click();
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'false');

  // LIVE REGION: present, and carries a status announcement (not empty).
  const live = labPage.locator('.olv-flow-live');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).not.toHaveText('');

  // The overlay was turned OFF, and it stays off across a close/reopen: the
  // reopened Lab reads back the SAME persisted overlay, not a fresh one
  // reset to its default.
  await clickTaskBack(page, 'analyse');
  await expect(page.locator('.olv-analyse-page[data-page="flow-pulse"]')).toBeHidden();
  await openFlowPulse(page);
  await expect(page.locator('.olv-analyse-page[data-page="flow-pulse"] .olv-story-card')).toContainText('D8 flow routing over the analysed DTM');
  await expect(page.locator('.olv-flow-overlay-toggle')).toHaveAttribute('aria-pressed', 'false');

  // Turned back ON, leaving the page — which covers the scene, the only place
  // a user could otherwise see it — must not tear it down; the toggle in the
  // reopened Lab reads back "on" because the same overlay is still attached.
  await page.locator('.olv-flow-overlay-toggle').click();
  await expect(page.locator('.olv-flow-overlay-toggle')).toHaveAttribute('aria-pressed', 'true');
  await clickTaskBack(page, 'analyse');
  await expect(page.locator('.olv-analyse-page[data-page="flow-pulse"]')).toBeHidden();
  await openFlowPulse(page);
  await expect(page.locator('.olv-flow-overlay-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('closing the scan tears down the persisted overlay without reopening the Lab', async ({ page }) => {
  // Closing a scan (and, by the same `abortAndClearCache()` path, loading a
  // different one, a CRS change, or a classification edit) must invalidate
  // the Lab's persisted 3D overlay even though the Lab itself stays closed
  // the whole time — `tests/flowOverlayInvalidation.test.ts` proves the
  // object-count side of this against a fake scene host; this proves the
  // user-visible side: a fresh Lab session on the NEXT scan never inherits
  // the "off" toggle the user set on the previous one, which it would if the
  // old overlay's persisted session had survived the close.
  await page.goto('/?test=1');
  await loadScanAndAnalyse(page);

  await openFlowPulse(page);
  const labPage = page.locator('.olv-analyse-page[data-page="flow-pulse"]');
  await expect(labPage.locator('.olv-story-card')).toContainText('D8 flow routing over the analysed DTM');
  const overlayToggle = labPage.locator('.olv-flow-overlay-toggle');
  await expect(overlayToggle).toBeVisible();
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'true');
  await overlayToggle.click();
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'false');
  await clickTaskBack(page, 'analyse');
  await expect(page.locator('.olv-analyse-page[data-page="flow-pulse"]')).toBeHidden();

  // Close the scan — no Lab reopen in between. Before the fix, nothing
  // disposed the persisted overlay on this path at all.
  await closeScanFromDock(page);
  await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 10_000 });

  // Load a fresh scan and re-run analysis; the new Lab session's overlay
  // toggle must start ON (the default), proving the previous scan's persisted
  // overlay was torn down by the close, not kept behind a stale "off" record.
  await loadScanAndAnalyse(page);
  await openFlowPulse(page);
  await expect(page.locator('.olv-analyse-page[data-page="flow-pulse"] .olv-story-card')).toContainText('D8 flow routing over the analysed DTM');
  await expect(page.locator('.olv-flow-overlay-toggle')).toHaveAttribute('aria-pressed', 'true');
});
