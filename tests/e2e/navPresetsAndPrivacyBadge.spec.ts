import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyLas } from './helpers';

/**
 * navPresetsAndPrivacyBadge.spec.ts
 *
 * The Inspector's navigation presets carry neutral, descriptive labels, and a
 * preset id stored by an earlier build still selects its renamed preset. The
 * header badge tooltip says what stays on the device and what does not.
 */

const PREFS_KEY = 'openlidarviewer.prefs.v1';

async function openWithScan(page: Page): Promise<void> {
  await suppressOnboardingTour(page);
  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible();
  await dropTinyLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
}

/** The preset select, with any collapsed section around it opened. */
async function presetSelect(page: Page) {
  const select = page.locator('select[aria-label="Navigation preset"]');
  await expect(select).toHaveCount(1);
  await select.evaluate((node) => {
    for (let d = node.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
  });
  return select;
}

test.describe('Inspector navigation presets', () => {
  test('offers neutral labels and persists the new id', async ({ page }) => {
    await openWithScan(page);
    const select = await presetSelect(page);
    const options = await select.locator('option').evaluateAll((opts) =>
      opts.map((o) => [(o as HTMLOptionElement).value, o.textContent]),
    );
    expect(options).toEqual([
      ['default', 'Default'],
      ['invert-vertical', 'Inverted vertical'],
      ['no-invert', 'No inversion'],
    ]);

    await select.selectOption('no-invert');
    await expect
      .poll(async () =>
        page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').navigation?.preset ?? null, PREFS_KEY),
      )
      .toBe('no-invert');
  });

  test('a preset id stored by an earlier build selects its renamed preset', async ({ page }) => {
    await page.addInitScript((key: string) => {
      try {
        localStorage.setItem(
          key,
          JSON.stringify({ navigation: { invertOrbitX: false, invertOrbitY: false, preset: 'nira' } }),
        );
      } catch {
        // Storage blocked: the assertion below will fail and say so.
      }
    }, PREFS_KEY);
    await openWithScan(page);
    const select = await presetSelect(page);
    await expect(select).toHaveValue('no-invert');
  });
});

test.describe('Header privacy badge', () => {
  test('keeps its label and does not overclaim in its tooltip', async ({ page }) => {
    await suppressOnboardingTour(page);
    await page.goto('/');
    const badge = page.locator('.olv-badge').first();
    await expect(badge).toHaveText('Private · on your device');
    await expect(badge).toHaveAttribute(
      'title',
      'Scans you open stay on your device. Remote datasets are downloaded from their hosts.',
    );
  });
});
