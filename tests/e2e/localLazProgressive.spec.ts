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
 * pool the way a large file would. `?debug=1` prints the load telemetry to the
 * console, which is how the spec reads what happened; the worker events are
 * Playwright's.
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

/** The debug overlay's resident point count once it reaches `expected`, else what it last said. */
async function pointsShown(page: Page, expected: number): Promise<number> {
  const read = (): number => {
    const dbg = document.querySelector('[class*=debug]')?.textContent ?? '';
    return Number(/points\s+([\d,]+) shown/.exec(dbg.replace(/\s+/g, ' '))?.[1]?.replace(/,/g, '') ?? -1);
  };
  await page.waitForFunction((n) => {
    const dbg = document.querySelector('[class*=debug]')?.textContent ?? '';
    return Number(/points\s+([\d,]+) shown/.exec(dbg.replace(/\s+/g, ' '))?.[1]?.replace(/,/g, '') ?? -1) === n;
  }, expected, { timeout: 30_000 }).catch(() => undefined);
  return page.evaluate(read);
}

test.describe('local LAZ, progressive path', () => {
  test('File to worker, ranged reads, chunk pool, preview, final cloud', async ({ page, browserName }) => {
    const r = await openProgressive(page, '&decodePool=on');

    // The page sent the File: no whole-file read row, ranged reads instead.
    expect(r.text).not.toMatch(/file read/);
    expect(r.text).toMatch(/range reads\s+\d+/);
    expect(r.text, r.text).toMatch(/decode path\s+pooled/);
    // The pool ran on workers of its own, made from the parse worker. The
    // telemetry says so in every engine; Playwright also reports the nested
    // workers themselves in Chromium and Firefox, and does not in WebKit.
    expect(r.text).toMatch(/pool workers\s+[1-9]/);
    if (browserName !== 'webkit') {
      expect(r.workerUrls.filter((u) => /lazChunkWorker/i.test(u)).length).toBeGreaterThan(0);
    }
    // Chunks reached the page before the final cloud; every record was handed on.
    expect(r.text).toMatch(/preview\s+[\d.]+ ms/);
    const previewPoints = Number(/preview pts\s+([\d,]+)/.exec(r.text)?.[1]?.replace(/,/g, ''));
    expect(previewPoints).toBeGreaterThan(0);
    expect(previewPoints).toBe(POINTS);

    // The final cloud replaced it: every point resident, no preview left.
    expect(await pointsShown(page, POINTS)).toBe(POINTS);
    expect(await page.evaluate(() => !!document.querySelector('.olv-empty.olv-hidden'))).toBe(true);

    expect(r.pageErrors, r.pageErrors.join('\n')).toEqual([]);
    expect(r.consoleErrors, r.consoleErrors.join('\n')).toEqual([]);
  });

  test('the single-reader path still produces the same cloud without the pool', async ({ page }) => {
    const r = await openProgressive(page, '&decodePool=off');
    expect(r.text).toMatch(/decode path\s+whole-file/);
    expect(r.text).not.toMatch(/preview\s+[\d.]+ ms/);
    expect(r.workerUrls.filter((u) => /lazChunkWorker/i.test(u))).toHaveLength(0);
    expect(await pointsShown(page, POINTS)).toBe(POINTS);
    expect(r.pageErrors).toEqual([]);
    expect(r.consoleErrors).toEqual([]);
  });
});
