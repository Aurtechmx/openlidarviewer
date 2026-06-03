import { test, expect } from '@playwright/test';
import fs from 'node:fs';

/**
 * Coverage for the v0.3.7 streaming-resident caveat caption.
 *
 * Profile + Volume measurements sampled against a streaming cloud carry
 * a "Resident-node analysis only — may refine as streaming loads"
 * caption beneath the headline row. This spec verifies the caption
 * actually renders when the cloud is streaming, with no UI surface for
 * activation other than placing the measurement.
 *
 * Auto-skips when the autzen COPC fixture is not on disk — CI runners
 * don't carry it, so the spec exits cleanly without the fixture and
 * runs end-to-end locally where the developer has it.
 */

const COPC_FILE =
  '/sessions/charming-vigilant-heisenberg/mnt/OPENLIDAR/autzen-classified.copc.laz';

const hasAutzenFixture = fs.existsSync(COPC_FILE);

test.describe('streaming-resident caveat caption (autzen COPC required)', () => {
  test.skip(!hasAutzenFixture, `requires the autzen COPC fixture at ${COPC_FILE}`);

  test('placing a Profile measurement on a streaming cloud surfaces the resident-only caveat', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();

    // Open the streaming COPC through the hidden file input.
    await page.locator('.olv-file-input').first().setInputFiles(COPC_FILE);

    // The streaming panel appears once metadata + hierarchy are read.
    const panel = page.locator('.olv-streaming-panel');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel).toContainText(/Refining|Streaming ready/, { timeout: 60_000 });

    // Enter measurement mode and pick the Profile kind. The profile
    // sampler needs two points; we drop them at deterministic NDC
    // positions inside the canvas.
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await expect(page.locator('.olv-measure-bar')).toBeVisible();
    await page.locator('.olv-mkind', { hasText: /^Profile$/ }).click();
    await expect(page.locator('.olv-mkind-active')).toHaveText('Profile');

    // Click two canvas points to commit the profile measurement.
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    await canvas.click({ position: { x: box.width * 0.3, y: box.height * 0.5 } });
    await page.waitForTimeout(150);
    await canvas.click({ position: { x: box.width * 0.7, y: box.height * 0.5 } });

    // The profile measurement appears in the panel; the caveat fades in
    // beneath the chart strip because the cloud is still streaming and
    // no fully-loaded static cloud is sitting beside the resident set.
    const caveat = page.locator('.olv-mp-chart-caveat');
    await expect(caveat).toBeVisible({ timeout: 30_000 });
    await expect(caveat).toContainText(/Resident-node analysis only/);
  });
});
