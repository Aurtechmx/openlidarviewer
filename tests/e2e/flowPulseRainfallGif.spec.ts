import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dropDenseGridUtmLas, firePaletteAction, openAnalysePanel } from './helpers';
import { decodeGif } from '../helpers/gifDecoder';

/**
 * Flow Pulse rainfall and watershed GIF, on a georeferenced scan (UTM, metres),
 * so square metres resolve and a peak flow is estimated:
 *
 *   - the rainfall slider scales the outlet's rational-method peak flow
 *     linearly (Q = C·i·A at a fixed area and C), read from the row's
 *     machine-readable figure, not its rounded text;
 *   - a pointer click in catchment mode snaps to the strongest channel nearby
 *     and the panel says so; the keyboard selection is exact;
 *   - Export GIF downloads `<name>-watershed-<col>-<row>.gif`, a GIF89a with
 *     more than one frame, decoded both by the test's own reader and by the
 *     browser's ImageDecoder where it exists.
 */

async function loadUtmScanAndAnalyse(page: Page): Promise<void> {
  await dropDenseGridUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ })).toBeEnabled({ timeout: 20_000 });
  await openAnalysePanel(page);
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, { timeout: 30_000 });
}

test('rainfall scales the outlet peak flow linearly, and Export GIF downloads an animated watershed', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?test=1');
  await loadUtmScanAndAnalyse(page);
  await firePaletteAction(page, 'Flow Pulse', 'Flow Pulse (Field Simulation Lab)');
  const lab = page.locator('.olv-analyse-page[data-page="flow-pulse"]');
  await expect(lab.locator('.olv-flow-grid-canvas')).toBeVisible({ timeout: 30_000 });

  // The rainfall control opens at its default and says what the map draws.
  const rain = lab.locator('.olv-flow-rain');
  await expect(rain).toBeVisible();
  const intensityValue = rain.locator('.olv-flow-rain-value').first();
  await expect(intensityValue).toHaveText('25 mm/h');
  await expect(rain.locator('.olv-flow-rain-note')).toContainText('reach the line threshold of 1 L/s estimated peak flow');

  // Catchment mode: snapping is on, and a click near the middle sets an outlet.
  await lab.locator('.olv-flow-mode-btn', { hasText: 'Set catchment outlet' }).click();
  const snap = lab.locator('.olv-flow-snap-toggle');
  await expect(snap).toBeVisible();
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  const grid = lab.locator('.olv-flow-grid-canvas');
  const box = await grid.boundingBox();
  if (!box) throw new Error('grid canvas has no box');
  await grid.click({ position: { x: box.width * 0.5, y: box.height * 0.85 } });
  const selection = lab.locator('.olv-flow-selection');
  await expect(selection).toContainText('Contributing cells', { timeout: 5_000 });
  await expect(selection).toContainText('Outlet');

  // Peak flow at 25, 50 and 100 mm/h: exactly proportional to the intensity.
  const peak = selection.locator('.olv-flow-peak');
  await expect(peak).toContainText('at 25 mm/h, C 0.2');
  const q25 = Number(await peak.getAttribute('data-q-m3s'));
  expect(q25).toBeGreaterThan(0);
  const slider = rain.locator('.olv-flow-rain-slider').first();
  await slider.fill('50');
  await expect(intensityValue).toHaveText('50 mm/h');
  await expect(peak).toContainText('at 50 mm/h, C 0.2');
  const q50 = Number(await peak.getAttribute('data-q-m3s'));
  await slider.fill('100');
  await expect(peak).toContainText('at 100 mm/h, C 0.2');
  const q100 = Number(await peak.getAttribute('data-q-m3s'));
  expect(q50 / q25).toBeCloseTo(2, 9);
  expect(q100 / q25).toBeCloseTo(4, 9);

  // Export GIF: name, header, and more than one frame.
  const gif = selection.locator('.olv-flow-gif-export');
  await expect(gif).toBeVisible();
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await gif.click();
  const download = await downloadPromise;
  const match = /-watershed-(\d+)-(\d+)\.gif$/.exec(download.suggestedFilename());
  expect(match, download.suggestedFilename()).not.toBeNull();
  const outletText = await selection.locator('.olv-story-row', { hasText: 'Outlet' }).first().innerText();
  expect(outletText).toContain(`col ${match![1]}, row ${match![2]}`);
  const bytes = new Uint8Array(readFileSync((await download.path())!));
  expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('GIF89a');
  const decoded = decodeGif(bytes);
  expect(decoded.frames.length).toBeGreaterThan(1);
  expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(1000);
  expect(decoded.loop).toBe(0);
  expect(decoded.comments.join('\n')).toContain('flow length');
  const browserFrames = await page.evaluate(async (data) => {
    const Decoder = (globalThis as unknown as { ImageDecoder?: new (init: { data: Uint8Array; type: string }) => { tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null } } }).ImageDecoder;
    if (!Decoder) return null;
    const d = new Decoder({ data: new Uint8Array(data), type: 'image/gif' });
    await d.tracks.ready;
    return d.tracks.selectedTrack?.frameCount ?? null;
  }, [...bytes]);
  if (browserFrames !== null) expect(browserFrames).toBe(decoded.frames.length);
  await expect(gif).toHaveText('Export GIF');

  // The keyboard sets the exact cell: no snap note.
  await grid.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(selection).toContainText(/Contributing cells|not drawn/, { timeout: 5_000 });
  await expect(selection.locator('.olv-flow-snap-note')).toHaveCount(0);
});
