import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, dropTinyPly, showWorkspaceMode } from './helpers';
import { COPC_FIXTURE } from './streamingFixtures';

/**
 * Class edits on a layer that is not active.
 *
 * Per-point class edits are kept by neither the session file nor the recovery
 * journal. Close scan and an exclusive streaming open remove every static
 * layer, so both must ask about class edits on any of them, named, and Cancel
 * must leave every layer, class buffer and undo history as it was. The layer
 * row's remove control removes one layer and asks only about that layer.
 *
 * Layer A (dense-grid.ply) is reclassified through the test seam; layer B
 * (tiny.ply) is opened after it, so B is the active layer and has no edits.
 */

interface LayerClassState { name: string; classAt0: number; epoch: number; canUndo: boolean }
interface Seam {
  seedUniformClass: (cls: number) => number;
  reclassifyLasso: (lasso: ReadonlyArray<{ x: number; y: number }>, cls: number) => number;
  layerClassStates: () => LayerClassState[];
}

const seam = (page: Page) => ({
  states: () => page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Seam }).__OLV_TEST_API__.layerClassStates()),
});

const confirmDialog = (page: Page) => page.locator('.olv-modal', { has: page.locator('.olv-confirm-body') });
const cancelButton = (page: Page) => page.locator('.olv-modal .olv-confirm-cancel:not(.olv-confirm-alternate)');

/** Open A, reclassify all of it to class 6, then open clean B over it. Returns A's state after the edit. */
async function editedAThenCleanB(page: Page): Promise<LayerClassState> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  const changed = await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: Seam }).__OLV_TEST_API__;
    api.seedUniformClass(1);
    return api.reclassifyLasso([{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 5000 }, { x: 0, y: 5000 }], 6);
  });
  expect(changed).toBeGreaterThan(0);
  await dropTinyPly(page);
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  const states = await seam(page).states();
  const a = states.find((s) => s.name === 'dense-grid.ply')!;
  expect(a).toMatchObject({ classAt0: 6, canUndo: true });
  expect(a.epoch).toBeGreaterThan(0);
  return a;
}

async function expectUnchanged(page: Page, a: LayerClassState): Promise<void> {
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(page.locator('.olv-layer')).toHaveCount(2);
  const states = await seam(page).states();
  expect(states.map((s) => s.name).sort()).toEqual(['dense-grid.ply', 'tiny.ply']);
  expect(states.find((s) => s.name === 'dense-grid.ply')).toEqual(a);
}

test('Close scan asks about class edits on a layer that is not active, and Cancel keeps everything', async ({ page }) => {
  const a = await editedAThenCleanB(page);
  await page.locator('.olv-tool-close').click();
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText('class edits on dense-grid.ply');
  await expect(dialog).toContainText('export dense-grid.ply as LAS');
  await expect(dialog.locator('.olv-confirm-alternate')).toHaveCount(0);
  await cancelButton(page).click();
  await expectUnchanged(page, a);
});

test('a hidden, locked edited layer still counts before Close scan', async ({ page }) => {
  const a = await editedAThenCleanB(page);
  await showWorkspaceMode(page, 'data');
  const rowA = page.locator('.olv-layer', { hasText: 'dense-grid' });
  await rowA.locator('input[type="checkbox"]').first().uncheck({ force: true });
  await rowA.locator('.olv-layer-lock').click();
  await expect(rowA.locator('.olv-layer-lock')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.olv-tool-close').click();
  await expect(confirmDialog(page)).toContainText('class edits on dense-grid.ply', { timeout: 10_000 });
  await cancelButton(page).click();
  await expectUnchanged(page, a);
});

test('opening a COPC over an edited layer that is not active asks first, and Cancel keeps everything', async ({ page }) => {
  const a = await editedAThenCleanB(page);
  await page.locator('.olv-file-input').first().setInputFiles(COPC_FIXTURE);
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText('Replace the open scan?');
  await expect(dialog).toContainText('class edits on dense-grid.ply');
  await expect(dialog).toContainText('export dense-grid.ply as LAS');
  await cancelButton(page).click();
  await expectUnchanged(page, a);
});

test('removing one layer asks about that layer only', async ({ page }) => {
  const a = await editedAThenCleanB(page);
  await showWorkspaceMode(page, 'data');
  // Removing the edited layer asks, and Cancel keeps it.
  await page.locator('.olv-layer', { hasText: 'dense-grid' }).locator('.olv-layer-x').click();
  await expect(confirmDialog(page)).toContainText('Removing dense-grid.ply discards its class edits.', { timeout: 10_000 });
  await cancelButton(page).click();
  await expectUnchanged(page, a);
  // Removing the clean layer while the edited one stays open is one click.
  await page.locator('.olv-layer', { hasText: 'tiny' }).locator('.olv-layer-x').click();
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 10_000 });
  await expect(confirmDialog(page)).toHaveCount(0);
  expect(await seam(page).states()).toEqual([a]);
});
