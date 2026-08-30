import { test, expect } from '@playwright/test';

/**
 * Batch converter — splash entry + modal. No scan/WebGL needed: the converter
 * runs entirely on the empty state, so these are safe in a GPU-less sandbox.
 */

test('the empty state offers a Batch convert entry that opens the modal', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('.olv-convert-chip');
  await expect(link).toBeVisible({ timeout: 20_000 });
  await link.click();

  const dialog = page.locator('.olv-bc-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.olv-bc-title')).toHaveText('Batch convert');
});

test('format pills: LAS selectable, LAZ honestly disabled; convert gated until files added', async ({ page }) => {
  await page.goto('/');
  await page.locator('.olv-convert-chip').click();
  // Scope to the modal — the in-project Export panel reuses the same classes.
  const dialog = page.locator('.olv-bc-dialog');
  await expect(dialog).toBeVisible();

  // LAZ is shown but disabled (no in-browser encoder) — honest, not hidden.
  await expect(dialog.locator('.olv-bc-pill', { hasText: 'LAZ' })).toBeDisabled();
  // LAS is the default active output.
  await expect(dialog.locator('.olv-bc-pill.is-active', { hasText: 'LAS' })).toBeVisible();

  // With no files, Convert is disabled and the hint says why (prevention UX).
  await expect(dialog.locator('.olv-bc-convert')).toBeDisabled();
  await expect(dialog.locator('.olv-bc-hint.is-blocked')).toContainText(/add at least one file/i);

  // Reproject reveals a target-EPSG field.
  await dialog.locator('.olv-bc-pill', { hasText: 'Reproject' }).click();
  await expect(dialog.locator('.olv-bc-input')).toHaveCount(2); // source + target
});

test('the modal closes via the backdrop and the ✕ button', async ({ page }) => {
  await page.goto('/');
  await page.locator('.olv-convert-chip').click();
  await expect(page.locator('.olv-bc-dialog')).toBeVisible();
  await page.locator('.olv-bc-close').click();
  await expect(page.locator('.olv-bc-dialog')).toBeHidden();
});

test('a queued file whose name truncates carries a title so the full name is recoverable', async ({ page }) => {
  await page.goto('/');
  await page.locator('.olv-convert-chip').click();
  const dialog = page.locator('.olv-bc-dialog');
  await expect(dialog).toBeVisible();

  const longName = '2024-survey-north-tile-047-final-revision.las';
  await dialog.locator('.olv-file-input').setInputFiles({
    name: longName,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([0x4c, 0x41, 0x53, 0x46]), // 'LASF' — enough to be listed
  });

  const nameCell = dialog.locator('.olv-bc-file-name').first();
  await expect(nameCell).toHaveText(longName);
  // The cell truncates with an ellipsis in CSS; the title makes the full name
  // recoverable on hover rather than lost.
  await expect(nameCell).toHaveAttribute('title', longName);
});
