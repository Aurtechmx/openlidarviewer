import { test, expect } from '@playwright/test';
import fs from 'node:fs';

/**
 * COPC streaming end-to-end coverage. The chunks-load smoke test drives a tiny
 * in-memory fake-COPC buffer through openStreamingCopc, so it runs on any
 * machine — including CI. The full-pipeline tests below drive the real
 * `autzen-classified.copc.laz` (~80 MB) and only run when that file is present;
 * on CI runners (and any clone without the fixture) they skip cleanly.
 */

const COPC_FILE =
  '/sessions/charming-vigilant-heisenberg/mnt/OPENLIDAR/autzen-classified.copc.laz';

/** True when the 80 MB autzen COPC fixture is on disk at COPC_FILE. */
const hasAutzenFixture = fs.existsSync(COPC_FILE);

test('the COPC streaming chunks load when a COPC file is opened', async ({ page }) => {
  // Regression guard for the v0.3.0 source-transform bug: the COPC subsystem is
  // code-split behind dynamic import()s. If the live-build source-transform mangles
  // those import specifiers, the chunks never emit and openStreamingCopc dies
  // with "Failed to fetch dynamically imported module" — surfaced to the user
  // (with the v0.3.0 error-classifier fix) as a "could not be loaded" toast.
  //
  // A 700-byte file carrying only the bytes detectCopc checks is enough to
  // route into openStreamingCopc and exercise every COPC dynamic import,
  // without needing a full 80 MB scan. `?debug=1` makes the load-error path
  // log to the console so a mangled import is visible there too.
  const moduleErrors: string[] = [];
  const note = (s: string): void => {
    if (/dynamically imported module|importing a module script/i.test(s)) {
      moduleErrors.push(s);
    }
  };
  page.on('console', (msg) => note(msg.text()));
  page.on('pageerror', (err) => note(err.message));

  await page.goto('/?debug=1');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  const fake = new Uint8Array(700);
  fake.set([0x4c, 0x41, 0x53, 0x46], 0); // "LASF"
  fake.set([0x63, 0x6f, 0x70, 0x63], 377); // "copc" — first VLR user id
  fake[393] = 1; // COPC info-VLR record id (u16 LE)

  await page.locator('.olv-file-input').first().setInputFiles({
    name: 'probe.copc.laz',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(fake),
  });

  // The streaming panel's `show()` sets `data-opened="1"` as a one-way
  // marker that survives the subsequent hide() — which happens fast on
  // a fake file that fails to parse. This is what the test actually
  // wants to assert: that openStreamingCopc was reached. Checking the
  // marker instead of live visibility eliminates the race where the
  // parser fails between two Playwright polls and the panel is hidden
  // by the time the next poll fires. 30 s envelope covers cold-WebGPU
  // CI runners that take 10–18 s to compile shaders before
  // viewer.ready resolves.
  await expect(page.locator('.olv-streaming-panel')).toHaveAttribute(
    'data-opened',
    '1',
    { timeout: 30_000 },
  );
  // Let the dynamic imports resolve (or fail).
  await page.waitForTimeout(2_500);

  // Decisive: no chunk failed to fetch, and the error toast (the fake file
  // does fail to parse, as expected) is not the resource-load message.
  expect(moduleErrors, moduleErrors.join('\n')).toHaveLength(0);
  const toast = page.locator('.olv-toast');
  if (await toast.isVisible()) {
    await expect(toast).not.toContainText('could not be loaded');
  }
});

test.describe('autzen COPC fixture (skipped when the file is not on disk)', () => {
  // The CI runner has no point-cloud fixtures, so these end-to-end tests skip
  // there. A developer with the autzen file at COPC_FILE runs them normally.
  test.skip(!hasAutzenFixture, `requires the autzen COPC fixture at ${COPC_FILE}`);

test('opens a real COPC file and streams it progressively', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  // Open the COPC file through the hidden file input.
  await page.locator('.olv-file-input').first().setInputFiles(COPC_FILE);

  // The streaming panel appears once metadata + hierarchy are read.
  const panel = page.locator('.olv-streaming-panel');
  await expect(panel).toBeVisible({ timeout: 60_000 });

  // Nodes stream in — the panel reaches a refining or ready phase.
  await expect(panel).toContainText(/Refining|Streaming ready/, { timeout: 60_000 });

  // The empty state is gone and navigation is live.
  await expect(page.locator('.olv-empty')).toBeHidden();
  await expect(page.locator('.olv-mode-active')).toHaveText('Orbit');

  // The scan summary is populated from the COPC metadata.
  await expect(panel).toContainText('COPC LAZ');
  await expect(panel).toContainText(/PDRF [678]/);

  // Saving a camera view adds it to the streaming panel's list.
  await expect(panel).toContainText('No saved views yet');
  await panel.locator('.olv-streaming-btn', { hasText: 'Save view' }).click();
  await expect(panel.locator('.olv-streaming-view-name')).toHaveText('View 1');
});

test('inspects a per-point readout on a streaming COPC node', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.locator('.olv-file-input').first().setInputFiles(COPC_FILE);

  const panel = page.locator('.olv-streaming-panel');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  // Wait for resident nodes to refine so the meshes are dense enough to hit.
  await expect(panel).toContainText(/Refining|Streaming ready/, { timeout: 60_000 });
  await page.waitForTimeout(2_500); // let the framing tween settle

  // Enter the Inspect tool — enabled on a streaming scan in v0.3.0.
  await page.locator('.olv-tool', { hasText: 'Inspect' }).click();

  // Sweep a grid of canvas points across the framed scan; a streaming-node
  // hit opens the point card. The grid is dense so a sparse coarse region
  // never makes the test flake.
  const canvas = page.locator('.olv-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const card = page.locator('.olv-inspect-card');
  const fractions = [0.5, 0.42, 0.58, 0.34, 0.66, 0.46, 0.54];
  let hit = false;
  for (const fx of fractions) {
    for (const fy of fractions) {
      await canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
      if (await card.isVisible()) {
        hit = true;
        break;
      }
    }
    if (hit) break;
  }
  expect(hit, 'an Inspect click landed on a streaming node point').toBe(true);

  // The card carries the per-point attribute rows decoded from the COPC node.
  await expect(card).toBeVisible();
  await expect(card.locator('.olv-inspect-row').first()).toBeVisible();
});

test('closes a streaming COPC scan back to the empty state', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.locator('.olv-file-input').first().setInputFiles(COPC_FILE);
  await expect(page.locator('.olv-streaming-panel')).toBeVisible({ timeout: 60_000 });

  await page.locator('.olv-tool', { hasText: 'Close' }).click();
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await expect(page.locator('.olv-streaming-panel')).toBeHidden();
});

}); // describe('autzen COPC fixture')
