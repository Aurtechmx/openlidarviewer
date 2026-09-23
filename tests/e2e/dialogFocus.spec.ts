import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyPly } from './helpers';

/**
 * dialogFocus.spec.ts
 *
 * Keyboard-focus regression coverage for the hand-rolled overlay dialogs that
 * did not go through `openModal()` / `wireDialogA11y()` (src/ui/Modal.ts):
 * CommandPalette, ShortcutSheet, HelpOverlay, BatchConverter,
 * WorkflowConfigPanel, and the canvas context menu. Each of these used to
 * either drop keyboard focus onto a hidden background control once Tab moved
 * off the dialog's own input, or (WorkflowConfigPanel) fail to close on
 * Escape at all once its trigger had blurred itself first. These tests pin
 * the fixed behaviour: focus never leaves the open dialog, Escape always
 * works, and closing hands focus back to a sane place.
 */

function isInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(
    (sel) => document.activeElement !== null && document.activeElement.closest(sel) !== null,
    selector,
  );
}

test.describe('command palette — focus containment', () => {
  async function open(page: Page): Promise<void> {
    await suppressOnboardingTour(page);
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.locator('.olv-palette')).toBeVisible();
  }

  test('carries dialog semantics', async ({ page }) => {
    await open(page);
    const card = page.locator('.olv-palette-card');
    await expect(card).toHaveAttribute('role', 'dialog');
    await expect(card).toHaveAttribute('aria-modal', 'true');
  });

  test('Shift+Tab never escapes to a background control, and Escape still closes it', async ({ page }) => {
    await open(page);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+Tab');
    expect(await isInside(page, '.olv-palette-card')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-palette')).toBeHidden();
  });

  test('the no-match empty state offers a next action, not just a dead-end label', async ({ page }) => {
    await open(page);
    await page.locator('.olv-palette-input').fill('zzqqxx-never-match');
    const empty = page.locator('.olv-palette-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/try a shorter search/i);
  });
});

test.describe('shortcut sheet — focus containment', () => {
  async function open(page: Page): Promise<void> {
    await suppressOnboardingTour(page);
    await page.goto('/');
    await page.keyboard.press('Shift+Slash'); // '?'
    await expect(page.locator('.olv-shortcuts')).toBeVisible();
  }

  test('carries dialog semantics labelled by its own title', async ({ page }) => {
    await open(page);
    const card = page.locator('.olv-shortcuts-card');
    await expect(card).toHaveAttribute('role', 'dialog');
    await expect(card).toHaveAttribute('aria-modal', 'true');
    const labelledby = await card.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    await expect(page.locator(`#${labelledby}`)).toHaveText('Keyboard shortcuts');
  });

  test('Shift+Tab twice never escapes to a background control, and Escape still closes it', async ({ page }) => {
    await open(page);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+Tab');
    expect(await isInside(page, '.olv-shortcuts-card')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-shortcuts')).toBeHidden();
  });

  test('the no-match empty state offers a next action', async ({ page }) => {
    await open(page);
    await page.locator('.olv-shortcuts-input').fill('zzqqxx-never-match');
    const empty = page.locator('.olv-shortcuts-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/try a shorter search/i);
  });
});

test.describe('help overlay — focus containment', () => {
  test.slow();
  async function open(page: Page): Promise<void> {
    await suppressOnboardingTour(page);
    await page.goto('/');
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /^Help$/ }).first().click();
    await expect(page.locator('.olv-help-backdrop')).toBeVisible();
  }

  test('carries dialog semantics and moves focus into the search field on open', async ({ page }) => {
    await open(page);
    const card = page.locator('.olv-help-card');
    await expect(card).toHaveAttribute('role', 'dialog');
    await expect(card).toHaveAttribute('aria-modal', 'true');
    const labelledby = await card.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    await expect(page.locator('.olv-help-search')).toBeFocused();
  });

  test('Tab never escapes into the background tool dock while the overlay is open', async ({ page, browserName }) => {
    // WebKit's default keyboard-navigation mode (what a real Safari user gets
    // without turning on "Full Keyboard Access") omits plain <button>s from
    // the native Tab sequence — same as handPan.spec.ts/localLazProgressive.
    // spec.ts already special-case elsewhere. trapTab() still intercepts the
    // boundary correctly (proven by the Escape-from-anywhere test below and
    // by dialogFocus's other engines), but the "walk through every control
    // via native Tab" middle ground can leave the dialog on WebKit here
    // because most of its controls are buttons, not form fields.
    test.skip(browserName === 'webkit', 'WebKit omits buttons from native Tab order by default');
    await open(page);
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    expect(await isInside(page, '.olv-help-card')).toBe(true);
    // The overflow / other dock buttons this used to land on live outside it.
    expect(await isInside(page, '.olv-dock')).toBe(false);
  });

  test('Escape closes the overlay from anywhere inside it', async ({ page }) => {
    await open(page);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-help-backdrop')).toBeHidden();
  });
});

test.describe('batch converter — focus containment', () => {
  async function open(page: Page): Promise<void> {
    await suppressOnboardingTour(page);
    await page.goto('/');
    await page.locator('.olv-convert-chip').click();
    await expect(page.locator('.olv-bc-dialog')).toBeVisible();
  }

  test('carries dialog semantics and moves focus in on open', async ({ page }) => {
    await open(page);
    const dialog = page.locator('.olv-bc-dialog');
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelledby = await dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(await isInside(page, '.olv-bc-dialog')).toBe(true);
  });

  test('Escape closes the dialog (previously did nothing)', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-bc-dialog')).toBeHidden();
  });

  test('Shift+Tab never escapes to the page behind the modal', async ({ page, browserName }) => {
    // See the same skip in the help-overlay block above: this dialog's
    // controls are almost entirely <button>s (format/CRS pills, convert,
    // close), which WebKit's default keyboard mode does not Tab through.
    test.skip(browserName === 'webkit', 'WebKit omits buttons from native Tab order by default');
    await open(page);
    for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+Tab');
    expect(await isInside(page, '.olv-bc-dialog')).toBe(true);
  });

  test('closing restores focus to the trigger that opened it', async ({ page, browserName }) => {
    // WebKit's default mode also does not focus a plain <button> on click
    // (the same "Full Keyboard Access" preference gates both); the trigger
    // never became `restoreTo` there, so there is nothing to restore to.
    test.skip(browserName === 'webkit', 'WebKit does not focus a clicked <button> by default');
    await open(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-convert-chip')).toBeFocused();
  });
});

test.describe('workflow config panel — focus containment', () => {
  async function openViaPalette(page: Page): Promise<void> {
    await suppressOnboardingTour(page);
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('workflow recorder settings');
    await page.keyboard.press('Enter');
    await expect(page.locator('.olv-wfc')).toBeVisible();
  }

  test('carries dialog semantics and moves focus in on open', async ({ page }) => {
    await openViaPalette(page);
    const card = page.locator('.olv-wfc-card');
    await expect(card).toHaveAttribute('role', 'dialog');
    await expect(card).toHaveAttribute('aria-modal', 'true');
    expect(await isInside(page, '.olv-wfc-card')).toBe(true);
  });

  test('Escape closes the panel even though the command palette already blurred its own trigger first', async ({ page }) => {
    await openViaPalette(page);
    // The palette closes (and blurs) before firing this action, so nothing
    // inside .olv-wfc ever held focus at the moment Escape is pressed — the
    // old per-element listener depended on that and silently did nothing.
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-wfc')).toBeHidden();
  });

  test('Shift+Tab never escapes to the page behind the panel', async ({ page, browserName }) => {
    // See the same skip on the help-overlay block above: enough of this
    // panel's controls are <button>s (segmented rows, shortcut capture,
    // reset) that WebKit's default keyboard mode runs out of native tab
    // stops among the panel's few checkboxes before reaching the far side.
    test.skip(browserName === 'webkit', 'WebKit omits buttons from native Tab order by default');
    await openViaPalette(page);
    for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+Tab');
    expect(await isInside(page, '.olv-wfc-card')).toBe(true);
  });

  test('Escape while capturing a shortcut cancels the capture, not the whole panel', async ({ page }) => {
    await openViaPalette(page);
    await page.locator('.olv-wfc-shortcut').click();
    await expect(page.locator('.olv-wfc-shortcut')).toHaveClass(/is-capturing/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-wfc')).toBeVisible();
    await expect(page.locator('.olv-wfc-shortcut')).not.toHaveClass(/is-capturing/);
  });
});

test.describe('canvas context menu — keyboard operability', () => {
  async function loadScan(page: Page): Promise<void> {
    await suppressOnboardingTour(page);
    await page.goto('/');
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(800);
  }

  test('Shift+F10 on the focused canvas opens the menu with the first row focused', async ({ page }) => {
    await loadScan(page);
    await page.locator('.olv-canvas').focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.locator('.olv-ctxmenu')).toBeVisible();
    await expect(page.locator('.olv-ctxmenu-item').first()).toBeFocused();
  });

  test('the ContextMenu key also opens it', async ({ page }) => {
    await loadScan(page);
    await page.locator('.olv-canvas').focus();
    await page.keyboard.press('ContextMenu');
    await expect(page.locator('.olv-ctxmenu')).toBeVisible();
  });

  test('ArrowDown / ArrowUp / Home / End rove focus between rows', async ({ page }) => {
    await loadScan(page);
    await page.locator('.olv-canvas').focus();
    await page.keyboard.press('Shift+F10');
    const rows = page.locator('.olv-ctxmenu-item');
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(rows.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('ArrowUp'); // wraps backward past the first row
    await expect(rows.last()).toBeFocused();
  });

  test('Escape closes the menu and restores focus to the canvas', async ({ page }) => {
    await loadScan(page);
    await page.locator('.olv-canvas').focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.locator('.olv-ctxmenu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-ctxmenu')).toBeHidden();
    await expect(page.locator('.olv-canvas')).toBeFocused();
  });
});
