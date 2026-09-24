import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, showWorkspaceMode } from './helpers';

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

async function openAnalyse(page: Page): Promise<void> {
  await showWorkspaceMode(page, 'analyse');
  const panel = page.locator('.olv-analyse-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
}

async function firePaletteAction(page: Page, query: string, rowText: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill(query);
  await expect(page.locator('.olv-palette-row', { hasText: rowText })).toBeVisible();
  await page.locator('.olv-palette-input').press('Enter');
  await expect(page.locator('.olv-palette')).toBeHidden();
}

async function openFlowPulse(page: Page): Promise<void> {
  await firePaletteAction(page, 'Flow Pulse', 'Flow Pulse (Field Simulation Lab)');
  await expect(page.locator('.olv-modal-title')).toHaveText('Field Simulation Lab: Flow Pulse');
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

test('refuses honestly, with no interactive controls, before any terrain analysis has run', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);

  await openFlowPulse(page);
  const card = page.locator('.olv-modal .olv-story-card');
  await expect(card).toContainText('Flow Pulse did not run');
  await expect(card).toContainText('Run terrain analysis');
  // No conditioning/grid/overlay controls for a run that never happened.
  await expect(page.locator('.olv-flow-cond')).toHaveCount(0);
  await expect(page.locator('.olv-flow-grid-canvas')).toHaveCount(0);
});

test('run, conditioning, click-to-pulse, catchment, keyboard path, and the overlay toggle', async ({ page }) => {
  await page.goto('/?test=1');
  await loadScanAndAnalyse(page);

  await openFlowPulse(page);
  const modal = page.locator('.olv-modal');

  // SUCCESS state: the run summary, naming the method it used.
  await expect(modal.locator('.olv-story-card')).toContainText('D8 flow routing over the analysed DTM');
  await expect(modal.locator('.olv-story-card')).toContainText('olv.simulation.terrain-flow.d8');

  // CONDITIONING: raw is the default, both options offered, raw is pressed.
  const rawBtn = modal.locator('.olv-flow-cond-btn', { hasText: 'Raw terrain' });
  const floodBtn = modal.locator('.olv-flow-cond-btn', { hasText: 'Priority-Flood conditioned' });
  await expect(rawBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(floodBtn).toHaveAttribute('aria-pressed', 'false');

  // Switching conditioning re-runs the model: the pressed state flips and the
  // record's own method list changes to name Priority-Flood.
  await floodBtn.click();
  await expect(floodBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  await expect(rawBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(modal.locator('.olv-story-card')).toContainText('priority-flood', { timeout: 10_000 });

  // CLICK-TO-PULSE via the keyboard-accessible result grid cursor (the
  // spec's own named alternative to a live-scan click — see FlowOverlay.ts
  // and flowResultGrid.ts for why). A click at the CENTRE of the raster lands
  // on the best-covered cell of this dense synthetic surface, so the mouse
  // path is exercised against a cell certain to trace.
  const grid = modal.locator('.olv-flow-grid-canvas');
  await expect(grid).toBeVisible();
  const box = await grid.boundingBox();
  if (!box) throw new Error('grid canvas has no box');
  await expect(modal.locator('.olv-flow-selection')).toContainText('Click a cell');
  await grid.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(modal.locator('.olv-flow-selection')).toContainText('Path cells', { timeout: 5_000 });

  // KEYBOARD PATH: the click above also focused the canvas. Arrow keys move
  // the cursor (the status line names the new cell — proof keyboard
  // navigation itself works) and Enter activates it; a corner cell on this
  // fixture may or may not carry a measured elevation, so either a trace or
  // an honest refusal is accepted here — both are real, tested outcomes.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect(modal.locator('.olv-flow-grid-status')).not.toContainText('Selected');
  await page.keyboard.press('Enter');
  await expect(modal.locator('.olv-flow-selection')).toContainText(/Path cells|not drawn/, { timeout: 5_000 });

  // CATCHMENT: switch mode, activate the centre cell again, get a
  // contributing-cells readout.
  await modal.locator('.olv-flow-mode-btn', { hasText: 'Set catchment outlet' }).click();
  await expect(modal.locator('.olv-flow-selection')).toContainText('Click a cell');
  await grid.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(modal.locator('.olv-flow-selection')).toContainText('Contributing cells', { timeout: 5_000 });

  // EXPORT: the package button downloads a ZIP built from the current run,
  // including the path just traced above.
  const exportBtn = modal.locator('.olv-flow-export');
  await expect(exportBtn).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await exportBtn.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-flow-pulse\.zip$/);

  // ACCUMULATION OVERLAY: offered (the Analyse panel wired real scene
  // membership through to the Lab), toggles, and states its own honesty
  // limit rather than implying discharge.
  const overlayToggle = modal.locator('.olv-flow-overlay-toggle');
  await expect(overlayToggle).toBeVisible();
  await expect(modal.locator('.olv-flow-overlay-legend')).toContainText('counts cells, not water');
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'false');
  await overlayToggle.click();
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'true');

  // LIVE REGION: present, and carries a status announcement (not empty).
  const live = modal.locator('.olv-flow-live');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).not.toHaveText('');

  // The overlay was left ON. Closing the modal — which covers the scene,
  // the only place a user could otherwise see it — must not tear
  // it down; the toggle in the reopened Lab reads back "on" because the
  // SAME persisted overlay is still attached to the scan, not a fresh one
  // reset to off. (Before the fix this always came back "false": the modal
  // disposed the overlay unconditionally on close.)
  await page.locator('.olv-modal-x').click();
  await expect(page.locator('.olv-modal')).toHaveCount(0);
  await openFlowPulse(page);
  await expect(page.locator('.olv-modal .olv-story-card')).toContainText('D8 flow routing over the analysed DTM');
  await expect(page.locator('.olv-flow-overlay-toggle')).toHaveAttribute('aria-pressed', 'true');

  // Turning it off is the visible way out, and it stays off across a close/reopen.
  await page.locator('.olv-flow-overlay-toggle').click();
  await expect(page.locator('.olv-flow-overlay-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.olv-modal-x').click();
  await expect(page.locator('.olv-modal')).toHaveCount(0);
  await openFlowPulse(page);
  await expect(page.locator('.olv-flow-overlay-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('closing the scan tears down the persisted overlay without reopening the Lab', async ({ page }) => {
  // Closing a scan (and, by the same `abortAndClearCache()` path, loading a
  // different one, a CRS change, or a classification edit) must invalidate
  // the Lab's persisted 3D overlay even though the Lab itself stays closed
  // the whole time — `tests/flowOverlayInvalidation.test.ts` proves the
  // object-count side of this against a fake scene host; this proves the
  // user-visible side: a fresh Lab session on the NEXT scan never inherits
  // an "on" toggle it never turned on itself, which it would if the old
  // overlay's persisted session had survived the close.
  await page.goto('/?test=1');
  await loadScanAndAnalyse(page);

  await openFlowPulse(page);
  const modal = page.locator('.olv-modal');
  await expect(modal.locator('.olv-story-card')).toContainText('D8 flow routing over the analysed DTM');
  const overlayToggle = modal.locator('.olv-flow-overlay-toggle');
  await expect(overlayToggle).toBeVisible();
  await overlayToggle.click();
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.olv-modal-x').click();
  await expect(page.locator('.olv-modal')).toHaveCount(0);

  // Close the scan — no Lab reopen in between. Before the fix, nothing
  // disposed the persisted overlay on this path at all.
  await page.locator('.olv-tool-close').click();
  await expect(page.locator('.olv-empty')).toBeVisible({ timeout: 10_000 });

  // Load a fresh scan and re-run analysis; the new Lab session's overlay
  // toggle must start OFF, proving the previous scan's persisted overlay was
  // torn down by the close, not merely hidden behind a stale "on" record.
  await loadScanAndAnalyse(page);
  await openFlowPulse(page);
  await expect(page.locator('.olv-modal .olv-story-card')).toContainText('D8 flow routing over the analysed DTM');
  await expect(page.locator('.olv-flow-overlay-toggle')).toHaveAttribute('aria-pressed', 'false');
});
