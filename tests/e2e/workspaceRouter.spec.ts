/**
 * The Tools mode is one task at a time. Its home is the launcher; choosing a
 * tool shows only that tool's panel under a `<- Tools  MEASURE` header. The
 * route remembers the page per mode, so leaving for Data and coming back
 * returns to the tool, and Back returns to the launcher. The single-key
 * shortcut runs the same command as the launcher, so it lands on the same page.
 * Deterministic project, committed multi-chunk LAZ.
 */
import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { showWorkspaceMode } from './helpers';

const FIXTURE = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));

async function openScan(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await page.locator('.olv-file-input').first().setInputFiles(FIXTURE);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 60_000 });
}

test.describe('workspace route', () => {
  test.slow();

  test('Tools -> Measure -> Data -> Tools shows Measure -> Back shows the launcher', async ({ page }) => {
    await openScan(page);
    await showWorkspaceMode(page, 'work');
    const launcher = page.locator('.olv-tool-launcher');
    const panel = page.locator('.olv-measure-panel');
    const task = page.locator('#olv-ws-mode-work .olv-ws-task');
    const title = task.locator('.olv-ws-task-title');
    await expect(launcher).toBeVisible();
    await expect(task).toBeHidden();

    await launcher.locator('.olv-tl-row', { hasText: 'Measure' }).click();
    await expect(panel).toBeVisible();
    await expect(launcher).toBeHidden();
    await expect(page.locator('#olv-ws-mode-work .olv-clip-panel, #olv-ws-mode-work .olv-anno-panel')).toHaveCount(2);
    await expect(page.locator('#olv-ws-mode-work .olv-clip-panel')).toBeHidden();
    await expect(title).toHaveText('Measure');
    await expect(title).toHaveAttribute('aria-current', 'page');
    await expect(title).toBeFocused();

    await showWorkspaceMode(page, 'data');
    await expect(panel).toBeHidden();
    await showWorkspaceMode(page, 'work');
    await expect(panel).toBeVisible();
    await expect(title).toHaveText('Measure');
    await expect(launcher).toBeHidden();

    // Back is a real button: keyboard reaches and activates it.
    const back = task.locator('.olv-ws-back');
    await expect(back).toHaveText(/Tools/);
    await back.focus();
    await page.keyboard.press('Enter');
    await expect(launcher).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(task).toBeHidden();
    // Routing is presentation only: Measure is still armed.
    await expect(page.locator('.olv-dock-measure')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the M shortcut from Data opens the same Measure page', async ({ page }) => {
    await openScan(page);
    await showWorkspaceMode(page, 'data');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('m');
    await expect(page.locator('.olv-ws-tab[data-mode="work"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.olv-measure-panel')).toBeVisible();
    await expect(page.locator('#olv-ws-mode-work .olv-ws-task-title')).toHaveText('Measure');
    await expect(page.locator('.olv-tool-launcher')).toBeHidden();
    // A shortcut from the canvas leaves focus where it was.
    await expect(page.locator('#olv-ws-mode-work .olv-ws-task-title')).not.toBeFocused();
  });

  test('the dock Measure button from Data opens the same Measure page', async ({ page }) => {
    await openScan(page);
    await showWorkspaceMode(page, 'data');
    await page.locator('.olv-dock-measure').click();
    await expect(page.locator('.olv-ws-tab[data-mode="work"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.olv-measure-panel')).toBeVisible();
    await expect(page.locator('#olv-ws-mode-work .olv-ws-task-title')).toHaveText('Measure');
    await expect(page.locator('.olv-tool-launcher')).toBeHidden();
  });
});
