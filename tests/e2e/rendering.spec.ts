import { test, expect, type Page } from '@playwright/test';
import { isBenignPageError } from './pageErrors';
import { dropTinyPly } from './helpers';

/**
 * Render-quality controls coverage. Toggling Eye Dome Lighting switches the
 * render loop onto the post-processing pipeline and compiles the EDL shader,
 * so these tests are the real exercise of that pipeline — a malformed node
 * graph would surface here as a page error or a dead canvas.
 */

/** Load the drone-survey sample and wait for it to render. */
async function loadSample(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  // Let the framing tween settle so a few frames have rendered.
  await page.waitForTimeout(800);
  // v0.3.8: the Rendering section is collapsible and starts closed
  // (the design intent is "first-paint density first"). The tests in
  // this spec target chips inside the Rendering body, so open the
  // disclosure first.
  await openRenderingSection(page);
}

async function openRenderingSection(page: Page): Promise<void> {
  const renderingDetails = page.locator('details.olv-section-collapsible', {
    has: page.locator('summary', { hasText: 'Rendering' }),
  });
  const isOpen = await renderingDetails.evaluate((d) =>
    (d as HTMLDetailsElement).open,
  );
  if (!isOpen) await renderingDetails.locator('summary').click();
}

test('toggling Eye Dome Lighting drives the post-processing pipeline cleanly', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(e.message); });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await loadSample(page);

  // The EDL toggle lives in the Rendering section of the Scan Intelligence panel.
  const edl = page.locator('.olv-chip', { hasText: 'Eye Dome Lighting' });
  await expect(edl).toBeVisible();

  // The STARTING state is not fixed, so do not assume it. `edlDefaultEnabled`
  // turns EDL on for desktop WebGPU and leaves it off on the WebGL 2 fallback,
  // so the default follows whatever adapter the runner exposes: off on a
  // headless Chromium or Firefox with no adapter, on in WebKit on a Mac, where
  // `requestAdapter()` really does hand back a Metal-backed device. This spec
  // used to hard-code "starts off", which quietly encoded the fallback path and
  // would fail on any Chrome runner that grew a working adapter.
  //
  // What the spec actually cares about is the TRANSITION: driving the render
  // loop onto the post-processing pipeline and back off again, cleanly, in
  // whichever order this backend starts in.
  const startedOn = await edl.evaluate((n) => n.classList.contains('olv-chip-active'));

  /** Flip EDL and assert both the chip and the strength row settle. */
  const toggleTo = async (on: boolean): Promise<void> => {
    await edl.click();
    if (on) {
      await expect(edl).toHaveClass(/olv-chip-active/);
      // The strength slider is revealed once EDL is on.
      await expect(page.locator('.olv-render-row')).toBeVisible();
    } else {
      await expect(edl).not.toHaveClass(/olv-chip-active/);
      await expect(page.locator('.olv-render-row')).toBeHidden();
    }
  };

  // First flip: away from wherever this backend started.
  await toggleTo(!startedOn);
  // Let many frames render through the pipeline the flip selected.
  await page.waitForTimeout(1500);
  // The canvas is still rendering and nothing threw or errored.
  await expect(page.locator('.olv-canvas')).toBeVisible();
  expect(errors).toEqual([]);

  // Second flip: back to the starting state, also cleanly. Between them both
  // the EDL post-processing path and the direct render path have been driven.
  await toggleTo(startedOn);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test('the Rendering panel switches point-size mode and antialiasing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(e.message); });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await loadSample(page);

  // Point-size mode — Adaptive is the default; switch to Fixed and back.
  const fixed = page.locator('.olv-chip', { hasText: 'Fixed' });
  const adaptive = page.locator('.olv-chip', { hasText: 'Adaptive' });
  await fixed.click();
  await expect(fixed).toHaveClass(/olv-chip-active/);
  await adaptive.click();
  await expect(adaptive).toHaveClass(/olv-chip-active/);

  // Antialiasing toggle.
  await page.locator('.olv-chip', { hasText: 'Antialiasing' }).click();
  await page.waitForTimeout(800);

  await expect(page.locator('.olv-canvas')).toBeVisible();
  expect(errors).toEqual([]);
});
