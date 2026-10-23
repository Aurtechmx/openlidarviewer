import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { isBenignPageError } from './pageErrors';

/**
 * A heavy LAS whose index cannot be stored opens as a labelled sample instead
 * of being refused. The page is told it has almost no device memory (so the
 * plan routes the file out of core) and a 1 MB storage quota (so the index
 * cannot fit).
 */

async function lasBase64(n: number, epsg?: number): Promise<string> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
  };
  const { writeLas14 } = await import('../../src/convert/writeLas');
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = 400000 + (i % 1000) * 1.5;
    y[i] = 5200000 + Math.floor(i / 1000) * 1.5;
    z[i] = 55 + (i % 13) * 0.4;
    intensity[i] = i & 0xffff;
    classification[i] = 2;
  }
  return Buffer.from(writeLas14({ count: n, x, y, z, intensity, classification }, epsg ? { epsg } : {})).toString('base64');
}

async function dropBase64(page: Page, base64: string, name: string): Promise<void> {
  const dt = await page.evaluateHandle(({ b, n }) => {
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const d = new DataTransfer();
    d.items.add(new File([bytes], n));
    return d;
  }, { b: base64, n: name });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

test('a heavy LAS with too little browser storage opens as a labelled sample', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(String(e)); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { value: 0.001, configurable: true });
    const storage = navigator.storage;
    Object.defineProperty(storage, 'estimate', {
      value: async () => ({ quota: 1_000_000, usage: 0 }),
      configurable: true,
    });
  });

  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await dropBase64(page, await lasBase64(120_000), 'heavy-sample.las');

  const notice = page.locator('.olv-lasso-toast-msg');
  await expect(notice).toContainText('heavy-sample.las', { timeout: 60_000 });
  await expect(notice).toContainText('without its streaming index');
  await expect(notice).toContainText(/storage/);
  await expect(page.locator('.olv-empty-title')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a sample that replaces a stream carries its own CRS and name, not the previous scan\'s', async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { value: 0.001, configurable: true });
    Object.defineProperty(navigator.storage, 'estimate', { value: async () => ({ quota: 1_000_000, usage: 0 }), configurable: true });
  });
  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  const copc = readFileSync('tests/fixtures/copc/terrain-access-utm.copc.laz').toString('base64');
  await dropBase64(page, copc, 'prior.copc.laz');
  const crs = page.locator('.olv-crs-epsg').first();
  await expect(crs).toContainText('32613', { timeout: 30_000 });

  await dropBase64(page, await lasBase64(120_000, 3857), 'replacement-sample.las');
  await expect(page.locator('.olv-lasso-toast-msg')).toContainText('replacement-sample.las', { timeout: 90_000 });
  await expect(crs).toContainText('3857');
  await expect(page.getByRole('button', { name: /Dataset: replacement-sample\.las/ })).toBeVisible();
});
