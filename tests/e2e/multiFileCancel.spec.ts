import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Cancel scope for a multi-file drop. "Cancel this file" stops the current
 * file and the next one opens; "Cancel remaining files" stops the current file
 * and the rest never start; one file shows a single Cancel.
 *
 * Deterministic: each file's whole-file read waits at a gate the test opens,
 * and `waiting` counts the reads that began, so a file that never started is
 * seen as a count that does not grow.
 */

const TINY_LAS = readFileSync(fileURLToPath(new URL('../../public/samples/tiny.las', import.meta.url)));

type Gate = { waiting: number; open: () => void };

async function installReadGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __olvReadGate: Gate };
    const held: Array<() => void> = [];
    w.__olvReadGate = { waiting: 0, open: () => { for (const go of held.splice(0)) go(); } };
    const read = Blob.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function (this: File): Promise<ArrayBuffer> {
      w.__olvReadGate.waiting += 1;
      return new Promise((resolve, reject) => {
        held.push(() => read.call(this).then(resolve, reject));
      });
    };
  });
}

const reads = (page: Page) => page.evaluate(() => (window as unknown as { __olvReadGate: Gate }).__olvReadGate.waiting);
const openGate = (page: Page) => page.evaluate(() => (window as unknown as { __olvReadGate: Gate }).__olvReadGate.open());

async function dropFiles(page: Page, names: string[]): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ raw, fileNames }) => {
      const dt = new DataTransfer();
      for (const n of fileNames) dt.items.add(new File([new Uint8Array(raw)], n));
      return dt;
    },
    { raw: [...TINY_LAS], fileNames: names },
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

test.describe('multi-file drop cancel scope', () => {
  test('Cancel this file lets the next file open', async ({ page }) => {
    await page.goto('/');
    await installReadGate(page);
    await dropFiles(page, ['first.las', 'second.las']);
    const toast = page.locator('.olv-toast');
    await expect(page.locator('.olv-toast-queue')).toHaveText('Opening 1 of 2 —');
    await expect(page.locator('.olv-toast-file')).toHaveText('first.las');
    await expect(page.locator('.olv-toast-text')).toContainText('Reading file');

    await toast.getByRole('button', { name: 'Cancel loading this file' }).click();
    await openGate(page);
    await expect(page.locator('.olv-toast-file')).toHaveText('second.las', { timeout: 20_000 });
    // The last file of the drop has nothing after it: one plain Cancel.
    await expect(toast.getByRole('button', { name: 'Cancel loading', exact: true })).toBeVisible();
    await expect(toast.getByRole('button', { name: /remaining/ })).toBeHidden();
    await expect.poll(async () => { await openGate(page); return page.locator('.olv-empty').isHidden(); },
      { timeout: 20_000 }).toBe(true);
    expect(await reads(page)).toBe(2);
  });

  test('Cancel remaining files stops the queue and restores the empty state', async ({ page }) => {
    await page.goto('/');
    await installReadGate(page);
    await dropFiles(page, ['first.las', 'second.las', 'third.las']);
    const toast = page.locator('.olv-toast');
    await expect(page.locator('.olv-toast-queue')).toHaveText('Opening 1 of 3 —');
    await expect(page.locator('.olv-toast-text')).toContainText('Reading file');

    await toast.getByRole('button', { name: 'Cancel this file and the 2 remaining files' }).click();
    await openGate(page);
    await expect(toast).toBeHidden();
    await expect(page.locator('.olv-empty')).toBeVisible();
    await expect(page.locator('body > .olv-visually-hidden[role="status"]')).toHaveText('Skipped 2 remaining files.');
    // Give a wrongly started second read the chance to show up.
    await page.waitForTimeout(300);
    expect(await reads(page)).toBe(1);
    await expect(page.locator('.olv-empty')).toBeVisible();
  });

  test('one file shows a single Cancel', async ({ page }) => {
    await page.goto('/');
    await installReadGate(page);
    await dropFiles(page, ['only.las']);
    const toast = page.locator('.olv-toast');
    await expect(toast.getByRole('button', { name: 'Cancel loading', exact: true })).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Cancel loading', exact: true })).toHaveText('Cancel');
    await expect(page.locator('.olv-toast-queue')).toBeHidden();
    await expect(toast.getByRole('button', { name: /remaining/ })).toBeHidden();
    await expect(page.locator('.olv-toast-text')).toContainText('Reading file');
    await openGate(page);
    await expect(toast).toBeHidden({ timeout: 20_000 });
  });
});
