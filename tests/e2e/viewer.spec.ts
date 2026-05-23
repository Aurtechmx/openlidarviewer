import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Drop-and-render coverage. The sample buttons load the bundled fixture
 * scans (a local fetch — no upload), exercising the same
 * load → render → validate path a dropped file takes.
 */

test('loads a drone survey sample and shows the scan report', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  await page.getByText('Drone survey').click();

  // The empty state gives way to the rendered cloud.
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-layer')).toHaveCount(1);
  // The Scan Report (Health Check + Scan Report rows) is populated.
  await expect(page.locator('.olv-report-row').first()).toBeVisible();
});

test('loads a second scan as a separate layer', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Drone survey').click();
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-layer')).toHaveCount(1);

  // The empty-state sample buttons are gone once a scan is open, so a second
  // scan arrives the way a real one does — dropped onto the window. Simulate
  // dropping the bundled .ply fixture on the document body.
  const ply = readFileSync(
    fileURLToPath(new URL('../../public/samples/tiny.ply', import.meta.url)),
  );
  const dataTransfer = await page.evaluateHandle((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'second-scan.ply'));
    return dt;
  }, [...ply]);
  await page.dispatchEvent('body', 'drop', { dataTransfer });

  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
});

test('opens a dropped E57 scan', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  // Drop the bundled E57 fixture — exercises the full sniff → parse → render path.
  const e57 = readFileSync(fileURLToPath(new URL('../bunnyFloat.e57', import.meta.url)));
  const dataTransfer = await page.evaluateHandle((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'bunny.e57'));
    return dt;
  }, [...e57]);
  await page.dispatchEvent('body', 'drop', { dataTransfer });

  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-layer')).toHaveCount(1);
  await expect(page.locator('.olv-report-row').first()).toBeVisible();
});

test('embed mode strips the top bar', async ({ page }) => {
  await page.goto('/?embed=1');
  await expect(page.locator('.olv-topbar')).toHaveCount(0);
  await expect(page.locator('.olv-canvas')).toBeVisible();
});

test('switches navigation modes and reveals the speed control', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Drone survey').click();
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  // The nav bar appears with Orbit selected by default.
  await expect(page.locator('.olv-mode-active')).toHaveText('Orbit');

  // Switching to Fly activates that mode and reveals the speed slider.
  await page.locator('.olv-mode', { hasText: 'Fly' }).click();
  await expect(page.locator('.olv-mode-active')).toHaveText('Fly');
  await expect(page.locator('.olv-nav-speed')).toBeVisible();

  // The keyboard shortcut '2' switches to Walk mode.
  await page.keyboard.press('Digit2');
  await expect(page.locator('.olv-mode-active')).toHaveText('Walk');
});

test('interface controls carry hover tooltips', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Drone survey', { exact: true }).click();
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  // Tool-dock buttons explain themselves on hover.
  await expect(page.locator('.olv-tool', { hasText: 'Frame' })).toHaveAttribute(
    'title',
    /view/i,
  );
  await expect(page.locator('.olv-tool', { hasText: 'Measure' })).toHaveAttribute(
    'title',
    /measure/i,
  );
  // Colour-mode chips carry a hint describing the mode.
  await expect(page.locator('.olv-chip', { hasText: 'Height' })).toHaveAttribute(
    'title',
    /height/i,
  );
});

test('remembers a settings change across a page reload', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Drone survey', { exact: true }).click();
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  // Switch point sizing to Fixed — a persisted preference.
  await page.locator('.olv-chip', { hasText: 'Fixed' }).click();
  await expect(page.locator('.olv-chip', { hasText: 'Fixed' })).toHaveClass(
    /olv-chip-active/,
  );

  // Reload the page and open a scan again — the choice should have survived.
  await page.reload();
  await page.getByText('Drone survey', { exact: true }).click();
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-chip', { hasText: 'Fixed' })).toHaveClass(
    /olv-chip-active/,
  );
});

test('closes a scan and returns to the empty state, ready for another', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Drone survey', { exact: true }).click();
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-layer')).toHaveCount(1);

  // Close the scan — the empty state returns and the layer is gone.
  await page.locator('.olv-tool', { hasText: 'Close' }).click();
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await expect(page.locator('.olv-layer')).toHaveCount(0);

  // A second scan can be loaded straight away from the empty state.
  await page.getByText('Phone scan', { exact: true }).click();
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-layer')).toHaveCount(1);
});
