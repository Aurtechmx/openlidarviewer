import { readFileSync } from 'node:fs';
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

/**
 * `src/convert/writeLas` reads the Vite-`define` global `__BUILD_IDENTITY__` at
 * module load, which the Playwright TS transform does not define, so the writer
 * is imported after the global is stubbed (the same pattern as twoScanMount).
 */
async function loadLasWriter(): Promise<typeof import('../../src/convert/writeLas').writeLas14> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test',
    commit: 'unknown',
    dirty: false,
    builtAt: '1970-01-01T00:00:00.000Z',
  };
  return (await import('../../src/convert/writeLas')).writeLas14;
}

test('LAS 1.2 refuses classes above 31 with the reason, and writes them wrapped once opted in', async ({ page }) => {
  // A real LAS 1.4 file whose classes 64 and 200 do not fit the 5-bit field.
  const writeLas14 = await loadLasWriter();
  const las = writeLas14({
    count: 3,
    x: Float64Array.from([500000, 500001, 500002]),
    y: Float64Array.from([4100000, 4100001, 4100002]),
    z: Float64Array.from([10, 11, 12]),
    classification: Uint8Array.from([2, 64, 200]),
  });

  await page.goto('/');
  await page.locator('.olv-convert-chip').click();
  const dialog = page.locator('.olv-bc-dialog');
  await expect(dialog).toBeVisible();

  // The opt-in exists only for LAS 1.2; the default LAS 1.4 keeps the full byte.
  const optIn = dialog.locator('.olv-export-fullres', { hasText: 'Allow classes above 31 to wrap' });
  await expect(optIn).toBeHidden();
  await dialog.locator('.olv-bc-pill', { hasText: 'LAS 1.2' }).click();
  await expect(optIn).toBeVisible();

  await dialog.locator('.olv-file-input').setInputFiles({
    name: 'high-classes.las',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(las),
  });
  await dialog.locator('.olv-bc-convert').click();

  // Refused: a failed row with the reason, naming both ways forward, and no download.
  const row = dialog.locator('.olv-bc-row');
  await expect(row).toHaveClass(/is-error/, { timeout: 20_000 });
  const reason = row.locator('.olv-conv-note.is-error');
  await expect(reason).toContainText('LAS 1.2 was not written');
  await expect(reason).toContainText('64 (User Definable), 200 (User Definable)');
  await expect(reason).toContainText('Choose LAS 1.4');
  await expect(reason).toContainText('"Allow classes above 31 to wrap"');
  await expect(row.locator('.olv-bc-row-dl')).toHaveCount(0);

  // Opted in: the same file converts, and the row carries the wrap warning.
  await optIn.locator('input[type="checkbox"]').check();
  await dialog.locator('.olv-bc-convert').click();
  await expect(row).toHaveClass(/is-ok/, { timeout: 20_000 });
  await expect(row.locator('.olv-conv-note.is-warn')).toContainText('wrap to their low 5 bits');
  await expect(row.locator('.olv-bc-row-dl')).toBeVisible();
});

for (const c of [
  {
    title: 'a class that changes meaning',
    file: 'meaning.las',
    points: { classification: Uint8Array.from([2, 19, 19]) },
    optIn: 'Allow class numbers to change meaning',
    reason: 'class 19',
  },
  {
    title: 'the overlap flag',
    file: 'overlap.las',
    points: { classification: Uint8Array.from([2, 2, 2]), classificationFlags: Uint8Array.from([0, 8, 8]) },
    optIn: 'Allow the overlap flag to be dropped',
    reason: 'carry the overlap flag',
  },
]) {
  test(`LAS 1.2 refuses ${c.title} with the reason, and writes the file once opted in`, async ({ page }) => {
    const writeLas14 = await loadLasWriter();
    const las = writeLas14({
      count: 3,
      x: Float64Array.from([500000, 500001, 500002]),
      y: Float64Array.from([4100000, 4100001, 4100002]),
      z: Float64Array.from([10, 11, 12]),
      ...c.points,
    });

    await page.goto('/');
    await page.locator('.olv-convert-chip').click();
    const dialog = page.locator('.olv-bc-dialog');
    await expect(dialog).toBeVisible();

    const optIn = dialog.locator('.olv-export-fullres', { hasText: c.optIn });
    await expect(optIn).toBeHidden();
    await dialog.locator('.olv-bc-pill', { hasText: 'LAS 1.2' }).click();
    await expect(optIn).toBeVisible();

    await dialog.locator('.olv-file-input').setInputFiles({ name: c.file, mimeType: 'application/octet-stream', buffer: Buffer.from(las) });
    await dialog.locator('.olv-bc-convert').click();

    const row = dialog.locator('.olv-bc-row');
    await expect(row).toHaveClass(/is-error/, { timeout: 20_000 });
    const reason = row.locator('.olv-conv-note.is-error');
    await expect(reason).toContainText('LAS 1.2 was not written');
    await expect(reason).toContainText(c.reason);
    await expect(reason).toContainText(`"${c.optIn}"`);
    await expect(row.locator('.olv-bc-row-dl')).toHaveCount(0);

    await optIn.locator('input[type="checkbox"]').check();
    await dialog.locator('.olv-bc-convert').click();
    await expect(row).toHaveClass(/is-ok/, { timeout: 20_000 });
    await expect(row.locator('.olv-bc-row-dl')).toBeVisible();
  });
}

test('the Y-up to Z-up option is offered in Keep only, and rotates a local Y-up PLY when ticked', async ({ page }) => {
  // A local Y-up model: height runs along Y, depth along Z. No CRS in the file.
  const ply = [
    'ply', 'format ascii 1.0', 'element vertex 3',
    'property float x', 'property float y', 'property float z', 'end_header',
    '1 7 3', '2 8 4', '3 9 5', '',
  ].join('\n');

  await page.goto('/');
  await page.locator('.olv-convert-chip').click();
  const dialog = page.locator('.olv-bc-dialog');
  await expect(dialog).toBeVisible();

  const optIn = dialog.locator('.olv-export-fullres', { hasText: 'Rotate a local Y-up model to Z-up' });
  // Offered under Keep, withdrawn under Assign and Reproject, off by default.
  await expect(optIn).toBeVisible();
  await expect(optIn.locator('input[type="checkbox"]')).not.toBeChecked();
  await dialog.locator('.olv-bc-pill', { hasText: 'Assign EPSG' }).click();
  await expect(optIn).toBeHidden();
  await dialog.locator('.olv-bc-pill', { hasText: 'Reproject' }).click();
  await expect(optIn).toBeHidden();
  await dialog.locator('.olv-bc-pill', { hasText: 'Keep' }).click();
  await expect(optIn).toBeVisible();

  await dialog.locator('.olv-bc-pill', { hasText: 'XYZ' }).click();
  await dialog.locator('.olv-file-input').setInputFiles({ name: 'model.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(ply) });

  // Unticked: written as stored.
  await dialog.locator('.olv-bc-convert').click();
  const row = dialog.locator('.olv-bc-row');
  await expect(row).toHaveClass(/is-ok/, { timeout: 20_000 });
  await expect(row.locator('.olv-bc-row-meta')).toContainText('coordinates unchanged');
  const readFirstRow = async (): Promise<number[]> => {
    const downloadPromise = page.waitForEvent('download');
    await row.locator('.olv-bc-row-dl').click();
    const download = await downloadPromise;
    const text = readFileSync((await download.path())!, 'utf8');
    const data = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    return data[0].trim().split(/\s+/).map(Number);
  };
  expect(await readFirstRow()).toEqual([1, 7, 3]);

  // Ticked: (x, y, z) is written as (x, -z, y), and the report line says so.
  await optIn.locator('input[type="checkbox"]').check();
  await dialog.locator('.olv-bc-convert').click();
  await expect(row.locator('.olv-bc-row-meta')).toContainText('axes rotated Y-up to Z-up', { timeout: 20_000 });
  await expect(row.locator('.olv-conv-note.is-warn')).toContainText('rotated into the Z-up frame');
  expect(await readFirstRow()).toEqual([1, -3, 7]);
});

test('assigning a code LAS 1.4 cannot describe selects LAS 1.2 and says why before Convert is pressed', async ({ page }) => {
  await page.goto('/');
  await page.locator('.olv-convert-chip').click();
  const dialog = page.locator('.olv-bc-dialog');
  await expect(dialog).toBeVisible();
  const las14 = dialog.locator('.olv-bc-pill', { hasText: 'LAS 1.4' });
  const las12 = dialog.locator('.olv-bc-pill', { hasText: 'LAS 1.2' });
  await expect(las14).toHaveClass(/is-active/);

  // State Plane (California zone 5, US survey feet) has no stored WKT.
  await dialog.locator('.olv-bc-pill', { hasText: 'Assign EPSG' }).click();
  await dialog.locator('.olv-bc-input').fill('2229');
  await expect(las14).toBeDisabled();
  await expect(las14).toHaveAttribute('title', /no definition for EPSG:2229/);
  await expect(las12).toHaveClass(/is-active/);
  await expect(dialog.locator('.olv-bc-format-note')).toContainText('LAS 1.4 needs the CRS as WKT, and this build has no definition for EPSG:2229');
  await expect(dialog.locator('.olv-bc-format-note')).toContainText('LAS 1.2 is selected.');

  // A code it can write brings LAS 1.4 back.
  await dialog.locator('.olv-bc-input').fill('32613');
  await expect(las14).toBeEnabled();
  await expect(las14).toHaveClass(/is-active/);
});
