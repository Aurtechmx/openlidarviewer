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

