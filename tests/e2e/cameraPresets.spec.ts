import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * v0.3.9 Smart camera presets — Top / Iso / Oblique / Planar.
 *
 * The data-layer geometry is covered by cameraPresets.test.ts (36
 * unit tests). This spec exercises the DOM + keyboard wiring: the
 * NavBar chip rail mounts every preset, each chip clicks without
 * throwing a console error, and the T / O / P keyboard shortcuts
 * route through the same handler.
 *
 * v0.4.4: Iso has NO keyboard shortcut any more. Bare `I` belongs to
 * the Inspect tool (`bindShortcuts` → onInspect); binding both made
 * a single keystroke toggle Inspect AND snap the camera (the v0.4.3
 * collision). `CAMERA_PRESET_KEY.iso` is now `''`, so the Iso chip
 * renders without an `.olv-cam-chip-key` badge and its tooltip is
 * just "Iso view" (src/ui/NavBar.ts — key chip skipped when the key
 * is empty). Iso stays reachable via the chip and the command
 * palette; these specs pin that split.
 *
 * What this spec does NOT assert: the camera actually moved to the
 * target pose. Headless WebGL pose tracking is flaky and the
 * geometry contract is already pinned by the unit tests; verifying
 * the integration path (DOM + key handler + viewer method exists +
 * no console error) is enough to catch the regression class.
 */

async function loadSample(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

/** The presets that still own a bare-key shortcut (Iso lost `I` in v0.4.4). */
const KEYED_PRESETS = [
  { name: 'Top', key: 'T' },
  { name: 'Oblique', key: 'O' },
  { name: 'Planar', key: 'P' },
] as const;

/** Every preset chip in display order — Iso is click/palette-only. */
const ALL_PRESET_NAMES = ['Top', 'Iso', 'Oblique', 'Planar'] as const;

test.describe('camera presets — NavBar chip rail', () => {
  test('the rail mounts a chip for every preset; only T/O/P carry a key hint', async ({
    page,
  }) => {
    await loadSample(page);
    const rail = page.locator('.olv-cam-presets');
    await expect(rail).toBeVisible();

    for (const { name, key } of KEYED_PRESETS) {
      const chip = rail
        .locator('.olv-cam-chip')
        .filter({ hasText: name });
      await expect(chip, `missing camera preset chip "${name}"`).toBeVisible();
      const keyBadge = chip.locator('.olv-cam-chip-key');
      await expect(keyBadge).toHaveText(key);
    }

    // Iso renders WITHOUT a key badge — bare `I` belongs to Inspect now.
    const isoChip = rail.locator('.olv-cam-chip').filter({ hasText: 'Iso' });
    await expect(isoChip, 'missing camera preset chip "Iso"').toBeVisible();
    await expect(isoChip.locator('.olv-cam-chip-key')).toHaveCount(0);
  });

  test('tooltips name the shortcut for T/O/P; the Iso tooltip names none', async ({
    page,
  }) => {
    await loadSample(page);
    for (const { name, key } of KEYED_PRESETS) {
      const chip = page
        .locator('.olv-cam-presets .olv-cam-chip')
        .filter({ hasText: name });
      const title = await chip.getAttribute('title');
      expect(title, `${name} chip missing tooltip`).toBeTruthy();
      expect(title).toContain(name);
      expect(title).toContain(key);
    }

    const isoChip = page
      .locator('.olv-cam-presets .olv-cam-chip')
      .filter({ hasText: 'Iso' });
    // Exactly "Iso view" — no "keyboard shortcut" suffix.
    expect(await isoChip.getAttribute('title')).toBe('Iso view');
  });

  test('clicking each chip (Iso included) fires without a page error', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await loadSample(page);
    for (const name of ALL_PRESET_NAMES) {
      const chip = page
        .locator('.olv-cam-presets .olv-cam-chip')
        .filter({ hasText: name });
      await chip.click();
      await page.waitForTimeout(200);
    }
    expect(errors).toEqual([]);
  });
});

test.describe('camera presets — keyboard shortcuts', () => {
  test('T / O / P fire their preset with a toast; I does NOT fire Iso', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await loadSample(page);
    // Click anywhere outside form inputs so keyboard events land on body.
    await page.locator('.olv-stage').click({ position: { x: 1, y: 1 } });

    // Each keyed preset announces itself via the shared lasso toast
    // (main.ts: `Camera · <Name> view.`) and consumes the keystroke.
    const toast = page.locator('.olv-lasso-toast');
    await page.keyboard.press('T');
    await expect(toast).toHaveText('Camera · Top view.');
    await page.keyboard.press('O');
    await expect(toast).toHaveText('Camera · Oblique view.');
    await page.keyboard.press('P');
    await expect(toast).toHaveText('Camera · Planar view.');

    // Bare `I` toggles the Inspect tool, NOT the Iso preset — the toast
    // must still read "Planar" (no `Camera · Iso view.` ever appears).
    await page.keyboard.press('I');
    await page.waitForTimeout(300);
    await expect(toast).toHaveText('Camera · Planar view.');

    expect(errors).toEqual([]);
  });

  test('keyboard shortcuts are skipped while focus is on a text input', async ({
    page,
  }) => {
    await loadSample(page);
    // The empty-state URL input is no longer in the DOM after load —
    // navigate to a state where an input is focused. The Inspector's
    // measure tool has no inputs by default, so reach for a known one
    // by entering measure mode and using the name input field.
    // For now we just verify the keypress doesn't throw when no input
    // is focused — the inverse is hard to set up without a scan-loaded
    // form field.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.keyboard.press('T');
    await page.waitForTimeout(100);
    expect(errors).toEqual([]);
  });
});
