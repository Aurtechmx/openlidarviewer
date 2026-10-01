import { test, expect, type Page } from '@playwright/test';
import { dropTinyLas, openClassesPage, railChromeSettled, expectHittable, showWorkspaceMode } from './helpers';

/**
 * Clear classifications on a producer-classified scan, driven through the
 * real Classes-page controls: Clear sets every point to class 1, the legend
 * and an inline note say so, Undo restores the producer codes exactly, and
 * Auto-classify then runs on the cleared layer, carrying the heuristic caption
 * and its limits. The Export panel states 'cleared' and then 'derived'.
 *
 * tiny.las carries ASPRS classes 1, 2, 3, 5 and 6.
 */

const LEGEND = '.olv-class-panel';
const ROW = `${LEGEND} .olv-cl-row`;
const CAPTION = `${LEGEND} .olv-cl-derived`;
const SHOTS = process.env.OLV_CLEARCLASS_SHOTS;

type Api = {
  showReclassify: () => Promise<void>;
  classAt: (i: number) => number;
};

const codes = (page: Page, n: number): Promise<number[]> =>
  page.evaluate((count) => {
    const api = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    // Stops at the end of the buffer, where classAt reads past it.
    return Array.from({ length: count }, (_, i) => api.classAt(i)).filter((c) => typeof c === 'number' && c >= 0);
  }, n);

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function exportClassHint(page: Page): Promise<string> {
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
  const box = panel.getByRole('checkbox', { name: 'Include classification' });
  await expect(box).toBeVisible({ timeout: 20_000 });
  return (await box.locator('xpath=ancestor::label/following-sibling::span[1]').textContent()) ?? '';
}

test('Clear, Undo, then Clear and Auto-classify on a classified scan', async ({ page }) => {
  await page.goto('/?test=1');
  await dropTinyLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openClassesPage(page);
  await expect(page.locator(ROW).first()).toBeVisible({ timeout: 20_000 });
  const sourceRows = await page.locator(ROW).count();
  expect(sourceRows).toBeGreaterThan(1);
  const N = 64;
  const source = await codes(page, N);
  expect(new Set(source).size).toBeGreaterThan(1);

  await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.showReclassify());
  await railChromeSettled(page);
  const clear = page.locator('[data-testid="reclass-clear"]');
  const note = page.locator('[data-testid="reclass-cleared-note"]');
  await expect(clear).toBeEnabled({ timeout: 10_000 });
  await expect(note).toBeHidden();

  // Clear: the legend lists class 1 alone and the note offers Undo / Restore.
  await expectHittable(clear);
  await clear.click();
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.locator(ROW).first()).toContainText('Unclassified');
  expect(await codes(page, N)).toEqual(source.map(() => 1));
  await expect(note).toBeVisible();
  await expect(note).toContainText('Producer classes cleared for this session');
  await expect(note.locator('[data-testid="reclass-note-undo"]')).toBeEnabled();
  await expect(note.locator('[data-testid="reclass-restore"]')).toBeVisible();
  await expect(page.locator(CAPTION)).toContainText('source classes cleared in viewer; all points class 1');
  await expect(clear).toBeDisabled();
  await page.mouse.move(1, 1);
  await shot(page, '01-cleared-legend-and-note');

  // Undo from the note restores the producer codes exactly.
  await note.locator('[data-testid="reclass-note-undo"]').click();
  expect(await codes(page, N)).toEqual(source);
  await expect(page.locator(ROW)).toHaveCount(sourceRows);
  await expect(note).toBeHidden();
  await expect(page.locator(CAPTION)).toBeHidden();
  await shot(page, '02-undo-restored');

  // Clear again; the Export panel says the classes were cleared.
  await clear.click();
  await expect(page.locator(ROW)).toHaveCount(1);
  expect(await exportClassHint(page)).toContain('source classes cleared in viewer; all points class 1');
  await expect(page.locator('.olv-export-panel')).toContainText('Classification included (source classes cleared in viewer; all points class 1)');
  await shot(page, '03-export-cleared');

  // Auto-classify now runs on the cleared layer: derived classes, heuristic caption.
  await openClassesPage(page);
  await railChromeSettled(page);
  await expect(page.locator('.olv-reclass-hint')).toContainText('no wires, poles, water, bridges or noise');
  const auto = page.locator('[data-testid="reclass-auto"]');
  await expectHittable(auto);
  await auto.click();
  await expect(page.locator(CAPTION)).toContainText(/Derived \(heuristic\).*not survey-grade/, { timeout: 30_000 });
  await expect(page.locator('.olv-lasso-toast')).toContainText('no wires, poles, water, bridges or noise', { timeout: 30_000 });
  const derived = await codes(page, N);
  expect(derived.some((c) => c !== 1)).toBe(true);
  await expect(note).toContainText('Classes derived for this session (heuristic)');
  await page.mouse.move(1, 1);
  await shot(page, '04-auto-classified');
  expect(await exportClassHint(page)).toMatch(/Derived \(heuristic\).*not survey-grade/);
  await shot(page, '05-export-derived');

  // Undo steps back over the derive to the cleared layer; Restore brings the file codes back.
  await openClassesPage(page);
  await railChromeSettled(page);
  await page.locator('[data-testid="reclass-note-undo"]').click();
  expect(await codes(page, N)).toEqual(source.map(() => 1));
  await expect(page.locator(CAPTION)).toContainText('source classes cleared in viewer');
  await page.locator('[data-testid="reclass-restore"]').click();
  expect(await codes(page, N)).toEqual(source);
  await expect(page.locator(ROW)).toHaveCount(sourceRows);
  await expect(note).toBeHidden();
  await expect(page.locator(CAPTION)).toBeHidden();
});
