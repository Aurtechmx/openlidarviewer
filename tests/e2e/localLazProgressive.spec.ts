import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { isBenignPageError } from './pageErrors';

/**
 * The progressive local-LAZ path, end to end, in every release browser:
 *
 *   page: File to the parse worker (no whole-file buffer)
 *     parse worker: header from a prefix, chunk table by range
 *       chunk-worker pool: laz-perf WASM per worker
 *         preview posted, shown, then replaced by the final cloud
 *
 * The committed multi-chunk fixture is small, so `?decodePool=on` engages the
 * pool the way a large file would and `?previewChunks=2` keeps the preview a
 * strict subset. `?debug=1` prints the load telemetry to the console, which
 * is how the spec reads what happened; the worker events are Playwright's.
 * Correctness only: no timing threshold is asserted.
 */

const FIXTURE = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));
const POINTS = 120_000;

async function openProgressive(page: Page, query: string) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const workerUrls: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isBenignPageError(msg.text())) consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (!isBenignPageError(err.message)) pageErrors.push(err.message);
  });
  page.on('worker', (w) => workerUrls.push(w.url()));

  await page.goto(`/?debug=1${query}`);
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  const telemetry = page.waitForEvent('console', {
    predicate: (msg) => msg.text().includes('load telemetry'),
    timeout: 60_000,
  });
  await page.locator('.olv-file-input').first().setInputFiles(FIXTURE);
  const text = (await telemetry).text();
  await expect(page.locator('.olv-empty')).toBeHidden();
  return { text, consoleErrors, pageErrors, workerUrls };
}

test.describe('local LAZ, progressive path', () => {
  test('File to worker, ranged reads, chunk pool, preview, final cloud', async ({ page }) => {
    const r = await openProgressive(page, '&decodePool=on&previewChunks=2');

    // The page sent the File: no whole-file read row, ranged reads instead.
    expect(r.text).not.toMatch(/file read/);
    expect(r.text).toMatch(/range reads\s+\d+/);
    expect(r.text).toMatch(/decode path\s+pooled/);
    // The pool ran on a worker of its own, made from the parse worker.
    expect(r.workerUrls.filter((u) => /lazChunkWorker/i.test(u)).length).toBeGreaterThan(0);
    // A preview came first, a strict subset of the final cloud.
    expect(r.text).toMatch(/preview\s+[\d.]+ ms/);
    const previewPoints = Number(/preview pts\s+([\d,]+)/.exec(r.text)?.[1]?.replace(/,/g, ''));
    expect(previewPoints).toBeGreaterThan(0);
    expect(previewPoints).toBeLessThan(POINTS);

    // The final cloud replaced it: every point resident, one layer, no preview.
    await expect(page.locator('.olv-layer-row, .olv-layerhealth-row-name').first()).toBeVisible();
    const shown = await page.evaluate(() => {
      const dbg = document.querySelector('[class*=debug]')?.textContent ?? '';
      return /points\s+([\d,]+) shown/.exec(dbg.replace(/\s+/g, ' '))?.[1]?.replace(/,/g, '');
    });
    expect(Number(shown)).toBe(POINTS);
    expect(await page.evaluate(() => !!document.querySelector('.olv-empty.olv-hidden'))).toBe(true);

    expect(r.pageErrors, r.pageErrors.join('\n')).toEqual([]);
    expect(r.consoleErrors, r.consoleErrors.join('\n')).toEqual([]);
  });

  test('the single-reader path still produces the same cloud without the pool', async ({ page }) => {
    const r = await openProgressive(page, '&decodePool=off');
    expect(r.text).toMatch(/decode path\s+whole-file/);
    expect(r.text).not.toMatch(/preview\s+[\d.]+ ms/);
    expect(r.workerUrls.filter((u) => /lazChunkWorker/i.test(u))).toHaveLength(0);
    const shown = await page.evaluate(() => {
      const dbg = document.querySelector('[class*=debug]')?.textContent ?? '';
      return /points\s+([\d,]+) shown/.exec(dbg.replace(/\s+/g, ' '))?.[1]?.replace(/,/g, '');
    });
    expect(Number(shown)).toBe(POINTS);
    expect(r.pageErrors).toEqual([]);
    expect(r.consoleErrors).toEqual([]);
  });
});
