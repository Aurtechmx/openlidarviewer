import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dropDenseGridPly, showWorkspaceMode } from './helpers';

/**
 * In-project Export / Convert panel — converts the open cloud to another
 * format. Needs a loaded scan (WebGL), so it runs where a GPU context exists.
 */

/**
 * Load a scan via `drop`, switch to the Output workspace mode, and return the
 * Export panel expanded (panels mount collapsed).
 */
async function openExportPanel(page: Page, drop: (page: Page) => Promise<void>): Promise<Locator> {
  await page.goto('/?test=1');
  await drop(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  // The Export panel lives in the Output workspace mode.
  await showWorkspaceMode(page, 'output');

  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
  return panel;
}

test('after a scan loads, the Export panel offers formats and exports a file', async ({ page }) => {
  const panel = await openExportPanel(page, dropDenseGridPly);

  // LAS active by default; LAZ honestly disabled.
  await expect(panel.locator('.olv-bc-pill.is-active', { hasText: 'LAS' })).toBeVisible();
  await expect(panel.locator('.olv-bc-pill', { hasText: 'LAZ' })).toBeDisabled();

  // Full-resolution toggle is present. The small test grid isn't reduced, so
  // the box is disabled with an honest "already full resolution" note. Target it
  // by accessible name — the export panel reuses the `olv-export-fullres-*`
  // classes across the full-res / compress / classification option rows.
  await expect(panel.getByRole('checkbox', { name: 'Convert at full resolution' })).toBeVisible();
  await expect(panel.locator('.olv-export-fullres-hint', { hasText: /full resolution/i })).toBeVisible();

  // Pick XYZ (small text output) and export → a download fires.
  await panel.locator('.olv-bc-pill', { hasText: 'XYZ' }).click();
  const downloadPromise = page.waitForEvent('download');
  // The converter's own Export button (the deliverables moved here from the
  // Inspector also carry `.olv-export-btn`, so target the converter class).
  await panel.locator('.olv-bc-convert').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.xyz$/);

  // Status confirms the export and reports points.
  await expect(panel.locator('.olv-export-status')).toContainText(/points|Exported/i);
});

/**
 * `src/convert/writeLas` reads the Vite-`define` global `__BUILD_IDENTITY__` at
 * module load, which the Playwright TS transform does not define, so the writer
 * is imported after the global is stubbed — same pattern as
 * `tests/e2e/batchConverter.spec.ts` and `twoScanMount.spec.ts`.
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

/** Drop raw bytes as a named file onto the app, the same synthesised-DataTransfer path every drop test uses. */
async function dropLasBytes(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ b, n }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(b)], n));
      return dt;
    },
    { b: [...bytes], n: name },
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

/**
 * Read each point's classification straight out of a written LAS file, masked
 * to the legacy 5-bit field the way a real LAS 1.2 reader would — proving what
 * actually landed on disk rather than trusting the app's own status line.
 */
async function readLegacyClasses(filePath: string, count: number): Promise<number[]> {
  const { parseLasHeader } = await import('../../src/io/lasHeader');
  const bytes = readFileSync(filePath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const header = parseLasHeader(buffer);
  const view = new DataView(buffer);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const rp = header.offsetToPointData + i * header.pointDataRecordLength;
    out.push(view.getUint8(rp + 15) & 0x1f);
  }
  return out;
}

/**
 * LAS 1.2 class-wrap opt-in — the in-project Export panel's counterpart to
 * `batchConverter.spec.ts`'s equivalent test. A real LAS 1.4 source (classes 64
 * and 200, which do not fit the legacy 5-bit field) is loaded as the ACTIVE
 * scan rather than queued in the batch modal, driving the panel's own gate.
 */
test('Export panel: LAS 1.2 class-wrap opt-in previews, refuses, then writes wrapped', async ({ page }) => {
  const writeLas14 = await loadLasWriter();
  const { legacyClassWrapRefusal, legacyClassWrapWarning, countLegacyClassWrap } =
    await import('../../src/convert/legacyClassGuard');

  const classes = [2, 64, 200];
  const las = writeLas14({
    count: classes.length,
    x: Float64Array.from([0, 1, 2]),
    y: Float64Array.from([0, 1, 0]),
    z: Float64Array.from([0, 0, 1]),
    classification: Uint8Array.from(classes),
  });

  const panel = await openExportPanel(page, (p) => dropLasBytes(p, las, 'high-classes.las'));
  // Wait for the classification to actually be attached — a scan-independent
  // row that shows whenever the cloud carries a classification, regardless of
  // format — before touching the format pills, so a slower engine's decode
  // can't leave the LAS 1.2 click racing an empty `summaryInfo()`.
  await expect(panel.getByRole('checkbox', { name: 'Include classification' })).toBeVisible({ timeout: 20_000 });

  // The opt-in exists only for LAS 1.2; the default LAS 1.4 keeps the full byte.
  const optIn = panel.locator('.olv-export-fullres', { hasText: 'Allow classes above 31 to wrap' });
  await expect(optIn).toBeHidden();
  await panel.locator('.olv-bc-pill', { hasText: 'LAS 1.2' }).click();
  await expect(optIn).toBeVisible();

  // The live preview states the same refusal the write gate would give,
  // fetched from the same shared constant the unit test pins.
  const wrap = countLegacyClassWrap(Uint8Array.from(classes));
  const refusal = legacyClassWrapRefusal(wrap);
  await expect(panel.locator('.olv-export-summary-note')).toHaveText(refusal, { timeout: 10_000 });

  // Refused without the opt-in: the status carries the refusal, and no file
  // reaches the browser's download queue.
  let downloadFired = false;
  page.once('download', () => { downloadFired = true; });
  await panel.locator('.olv-bc-convert').click();
  await expect(panel.locator('.olv-export-status')).toHaveText(refusal, { timeout: 10_000 });
  expect(downloadFired, 'a file was written despite the refusal').toBe(false);

  // Opt in: the same file converts, and the written classes read back wrapped
  // to their low 5 bits — 64 as 0, 200 as 8 — exactly as the hint documents.
  await optIn.locator('input[type="checkbox"]').check();
  const downloadPromise = page.waitForEvent('download');
  await panel.locator('.olv-bc-convert').click();
  const download = await downloadPromise;
  await expect(panel.locator('.olv-export-status')).toHaveText(legacyClassWrapWarning(wrap.points));

  const path = await download.path();
  if (!path) throw new Error('download produced no local path');
  const written = await readLegacyClasses(path, classes.length);
  expect(written).toEqual(classes.map((c) => c & 0x1f));
});

/**
 * The wrap opt-in row is offered whenever LAS 1.2 would write A classification
 * at all — it does not pre-inspect whether any code actually exceeds 31 (the
 * same row, unconditional on format, in the splash BatchConverter). For a
 * cloud whose classes all already fit, the row is present but inert: the live
 * preview says nothing about wrapping and the plain export (opt-in left
 * unticked) proceeds unchanged. Pinned in Node by
 * `tests/exportPanelLegacyClassWrap.test.ts` ("classes all fit" / "shows only
 * while LAS 1.2 would write a classification"); this is its live-browser
 * counterpart.
 */
test('Export panel: a scan whose classes stay at or below 31 exports unchanged, opt-in untouched', async ({ page }) => {
  const writeLas14 = await loadLasWriter();
  const las = writeLas14({
    count: 4,
    x: Float64Array.from([0, 1, 2, 3]),
    y: Float64Array.from([0, 1, 0, 1]),
    z: Float64Array.from([0, 0, 1, 1]),
    classification: Uint8Array.from([0, 2, 6, 31]),
  });

  const panel = await openExportPanel(page, (p) => dropLasBytes(p, las, 'low-classes.las'));
  await expect(panel.getByRole('checkbox', { name: 'Include classification' })).toBeVisible({ timeout: 20_000 });

  await panel.locator('.olv-bc-pill', { hasText: 'LAS 1.2' }).click();
  const optIn = panel.locator('.olv-export-fullres', { hasText: 'Allow classes above 31 to wrap' });
  await expect(optIn).toBeVisible();
  const optInBox = optIn.locator('input[type="checkbox"]');
  await expect(optInBox).not.toBeChecked();

  // The preview never mentions wrapping — there is nothing to wrap.
  await expect(panel.locator('.olv-export-summary-note')).not.toContainText(/wrap|above 31|5-bit|5 bits/i);

  const downloadPromise = page.waitForEvent('download');
  await panel.locator('.olv-bc-convert').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.las$/);
  await expect(panel.locator('.olv-export-status')).not.toContainText(/refused|not written/i);
});

/**
 * The one case the row IS actually hidden for: no classification at all, so
 * there is nothing for a legacy write to wrap regardless of format. Unlike
 * the case above, this holds even before LAS 1.2 is picked.
 */
test('Export panel: a scan with no classification shows no wrap checkbox for any format', async ({ page }) => {
  // dropDenseGridPly carries RGB only, no classification channel
  const panel = await openExportPanel(page, dropDenseGridPly);
  await expect(panel.getByRole('checkbox', { name: 'Include classification' })).toHaveCount(0);

  const optIn = panel.locator('.olv-export-fullres', { hasText: 'Allow classes above 31 to wrap' });
  await expect(optIn).toBeHidden();
  await panel.locator('.olv-bc-pill', { hasText: 'LAS 1.2' }).click();
  await expect(optIn).toBeHidden();
});
