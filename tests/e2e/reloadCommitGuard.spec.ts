import { test, expect, type Page } from '@playwright/test';
import { openReducedLas } from './reducedLas';

/**
 * "Reload at higher density" never replaces a layer whose classes changed.
 *
 * The reload reopens the layer's file and then removes the old layer. Class
 * edits made on the old layer in between would go with it, so the replacement
 * is refused and the original kept.
 *
 * Two windows exist. While the confirm dialog is open, its backdrop covers the
 * canvas, so the edit here comes from outside the dialog (the test seam); the
 * guard is a re-check at confirm time. While the file decodes, nothing covers
 * the canvas or the tools (the only progress UI is a small toast), so a real
 * lasso edit can land. The seam stands in for the lasso in both.
 */

const N = 2_400_000;

type Api = { seedUniformClass(c: number): number; classAt(i: number): number };

async function loadingRow(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const row of Array.from(document.querySelectorAll('.olv-layerhealth-row'))) {
      if (row.querySelector('dt')?.textContent === 'Loading') return row.querySelector('dd')?.childNodes[0]?.textContent ?? '';
    }
    return '';
  });
}

async function openAndReachLoadingRow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    new MutationObserver(() => {
      const t = document.querySelector('.olv-lasso-toast.olv-visible .olv-lasso-toast-msg')?.textContent ?? '';
      if (t && w.__toasts[w.__toasts.length - 1] !== t) w.__toasts.push(t);
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await openReducedLas(page, N, 4);
  await expect.poll(async () => {
    await page.locator('.olv-ss-basis').dispatchEvent('click').catch(() => {});
    return loadingRow(page);
  }, { timeout: 0, intervals: [5_000] }).toMatch(/^display sample: [\d,]+ of 2,400,000 declared points resident$/);
}

const toasts = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);
const layerCount = (page: Page): Promise<number> => page.evaluate(() => document.querySelectorAll('.olv-layerhealth-layer').length);

test('a class edit made while the confirm dialog is open stops the reload', async ({ page }) => {
  test.setTimeout(1_200_000);
  await openAndReachLoadingRow(page);
  const link = page.locator('.olv-ss-fullfile [data-full-file="reload"]');
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.dispatchEvent('click');
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Reload', exact: true });
  await expect(confirm).toBeVisible({ timeout: 20_000 });

  // The dialog's backdrop is what sits over the canvas.
  const top = await page.evaluate(() => {
    const c = document.querySelector('canvas')!.getBoundingClientRect();
    return document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)?.className?.toString() ?? '';
  });
  expect(top, 'the element over the canvas while the dialog is open').not.toBe('olv-canvas');

  await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.seedUniformClass(2));
  await confirm.dispatchEvent('click');

  await expect.poll(() => toasts(page), { timeout: 60_000 }).toEqual(expect.arrayContaining([expect.stringContaining('classes differ from the file')]));
  expect(await layerCount(page)).toBe(1);
  expect(await loadingRow(page)).toMatch(/^display sample: /);
  expect(await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.classAt(0))).toBe(2);
});

test('a class edit made while the file decodes keeps the original layer', async ({ page }) => {
  test.setTimeout(1_500_000);
  await openAndReachLoadingRow(page);
  const link = page.locator('.olv-ss-fullfile [data-full-file="reload"]');
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.dispatchEvent('click');
  await page.getByRole('dialog').getByRole('button', { name: 'Reload', exact: true }).dispatchEvent('click');

  // The decode is under way. Nothing covers the canvas, so a lasso edit can land.
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 });
  const top = await page.evaluate(() => {
    const c = document.querySelector('canvas')!.getBoundingClientRect();
    return document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)?.className?.toString() ?? '';
  });
  expect(top, 'the element over the canvas while the file decodes').toBe('olv-canvas');
  await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.seedUniformClass(2));

  await expect.poll(() => toasts(page), { timeout: 0, intervals: [5_000] })
    .toEqual(expect.arrayContaining([expect.stringMatching(/^The reload was refused: its classes changed while it ran\./)]));
  const refusal = (await toasts(page)).find((t) => t.startsWith('The reload was refused'))!;
  expect(refusal).toContain('original layer and its edits are kept');
  // One layer remains, and it is the edited original.
  await expect.poll(() => layerCount(page), { timeout: 60_000 }).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.classAt(0))).toBe(2);
});
