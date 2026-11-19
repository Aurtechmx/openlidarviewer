import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { showWorkspaceMode, suppressOnboardingTour, waitForLoadIdle } from './helpers';

/**
 * localUnitPicker.spec.ts
 *
 * A GLB opens as local coordinates in metres from the glTF specification. Its
 * display profile collapses the Coordinate system section instead of hiding
 * it, so a click on the section opens the picker, and the local-unit choice
 * there changes the frame.
 */

const FIXTURE = 'tiny.glb';

test('a GLB\'s collapsed Coordinate system section opens with a click and takes a local unit', async ({ page }) => {
  await suppressOnboardingTour(page);
  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible();
  const bytes = readFileSync(fileURLToPath(new URL(`../fixtures/${FIXTURE}`, import.meta.url)));
  const dataTransfer = await page.evaluateHandle(
    ([b, n]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(b as number[])], n as string));
      return dt;
    },
    [[...bytes], FIXTURE] as const,
  );
  await waitForLoadIdle(page);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await showWorkspaceMode(page, 'data');

  const summary = page.locator('summary', { hasText: 'Coordinate system' }).first();
  await expect(summary).toBeVisible();
  // Collapsed, not hidden.
  expect(await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open)).toBe(false);
  await summary.click();
  await expect(page.locator('.olv-crs-name').first()).toHaveText('Local coordinates in metres (no CRS)', { timeout: 15_000 });
  await expect(page.locator('.olv-crs-meta').first()).toContainText('Source: glTF specification (metres)');

  const select = page.locator('.olv-crs-select').first();
  await expect(select).toBeVisible();
  await select.selectOption('__local_ft__');
  await expect(page.locator('.olv-crs-name').first()).toHaveText('Local coordinates in international feet (no CRS)');
  await expect(page.locator('.olv-crs-meta').first()).toContainText('Source: User override');
});
