import { test, expect, type Page } from '@playwright/test';
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
}

test('toggling Eye Dome Lighting drives the post-processing pipeline cleanly', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await loadSample(page);

  // The EDL toggle lives in the Rendering section of the Scan Intelligence panel.
  const edl = page.locator('.olv-chip', { hasText: 'Eye Dome Lighting' });
  await expect(edl).toBeVisible();

  // Turn EDL on — the render loop switches to the post-processing pipeline and
  // the EDL shader compiles on the active GPU backend.
  await edl.click();
  await expect(edl).toHaveClass(/olv-chip-active/);
  // The strength slider is revealed once EDL is on.
  await expect(page.locator('.olv-render-row')).toBeVisible();

  // Let many frames render through the EDL pipeline.
  await page.waitForTimeout(1500);

  // The canvas is still rendering and nothing threw or errored.
  await expect(page.locator('.olv-canvas')).toBeVisible();
  expect(errors).toEqual([]);

  // Turning EDL back off returns to the direct render path, also cleanly.
  await edl.click();
  await expect(edl).not.toHaveClass(/olv-chip-active/);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test('the Rendering panel switches point-size mode and antialiasing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
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
