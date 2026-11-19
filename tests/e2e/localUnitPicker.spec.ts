import { test, expect } from '@playwright/test';
import { dropFixtureFile, showWorkspaceMode, suppressOnboardingTour } from './helpers';

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
  await dropFixtureFile(page, FIXTURE);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await showWorkspaceMode(page, 'data');

  // The display profile is applied once its provenance headline is in the
  // Inspector; the section's collapsed state is set in the same step.
  await expect(page.locator('.olv-declared-prov-headline').first()).toContainText('local coordinates', { timeout: 20_000 });
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
