/**
 * openAnyProbe.spec.ts
 *
 * "Open any point cloud", phase A, end to end: a dropped file is identified by
 * its content, not its name. A LAS renamed to .bin opens as LAS; random bytes
 * get the open failure report with a Copy report control; a PNG is named as an
 * image, not a point cloud; an extension-less XYZ text file opens at PROBABLE
 * with a notice, and the Inspector's Provenance section states the level.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { suppressOnboardingTour } from './helpers';

async function drop(page: Page, bytes: number[], name: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ([b, n]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(b as number[])], n as string));
      return dt;
    },
    [bytes, name] as const,
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

/** Deterministic pseudo-random bytes. */
function noise(n: number): number[] {
  const out: number[] = new Array(n);
  let x = 2463534242;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

test.beforeEach(async ({ page }) => {
  await suppressOnboardingTour(page);
  // Capture clipboard writes in every engine without a permission prompt.
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (t: string) => {
          (window as unknown as { __copied: string[] }).__copied.push(t);
        },
      },
    });
  });
  // One navigation per test: a second goto while the first page is still loading
  // aborts it in Firefox (NS_BINDING_ABORTED). ?test=1 exposes the test seam.
  await page.goto('/?test=1');
});

test('a LAS file renamed to .bin opens as LAS', async ({ page }) => {
  const bytes = readFileSync(fileURLToPath(new URL('../../public/samples/tiny.las', import.meta.url)));
  await drop(page, [...bytes], 'survey.bin');
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.olv-toast-error')).toHaveCount(0);
});

test('random bytes get the failure report with Copy report', async ({ page }) => {
  await drop(page, noise(300 * 1024), 'capture-07.bin');
  const toast = page.locator('.olv-toast');
  await expect(toast).toHaveClass(/olv-toast-error/, { timeout: 30_000 });
  await expect(page.locator('.olv-toast-text')).toContainText('not recognised as a point cloud');
  await expect(page.locator('.olv-toast-text')).toContainText('compressed or encrypted');
  await expect(page.locator('.olv-toast').getByRole('button', { name: 'Copy report', exact: true })).toBeVisible();
  // The label changes on click, so hold the control by position, not by name.
  const copy = page.locator('.olv-toast-row button').last();
  await copy.click();
  await expect(copy).toHaveText('Report copied');
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(copied).toHaveLength(1);
  const report = copied[0];
  expect(report).toContain('Verdict: OPAQUE');
  expect(report).toContain('Content: binary');
  expect(report).toContain('Sampled: 307200 bytes');
  expect(report).toMatch(/Byte entropy: (7\.9\d|8\.00) bits per byte/);
  expect(report).not.toContain('capture-07');
});

test('a PNG is reported as not a point cloud', async ({ page }) => {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...noise(2000)];
  await drop(page, png, 'photo.png');
  await expect(page.locator('.olv-toast')).toHaveClass(/olv-toast-error/, { timeout: 30_000 });
  await expect(page.locator('.olv-toast-text')).toContainText('PNG image, not a point cloud');
});

test('a failed open leaves the loaded project untouched', async ({ page }) => {
  const bytes = readFileSync(fileURLToPath(new URL('../../public/samples/tiny.las', import.meta.url)));
  await drop(page, [...bytes], 'tiny.las');
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  // The active scan's point count, read through the ?test=1 seam (0 when no scan is active).
  const points = () =>
    page.evaluate(() =>
      (window as unknown as { __OLV_TEST_API__: { seedUniformClass(c: number): number } }).__OLV_TEST_API__.seedUniformClass(1),
    );
  await expect.poll(points, { timeout: 20_000 }).toBeGreaterThan(0);
  const before = await points();

  await drop(page, noise(300 * 1024), 'unknown.bin');
  await expect(page.locator('.olv-toast')).toHaveClass(/olv-toast-error/, { timeout: 30_000 });
  await expect(page.locator('.olv-toast').getByRole('button', { name: 'Copy report', exact: true })).toBeVisible();

  await expect(page.locator('.olv-empty')).toBeHidden();
  expect(await points()).toBe(before);
});

test('an extension-less XYZ text file opens with the PROBABLE notice and level', async ({ page }) => {
  const rows = Array.from({ length: 40 }, (_, i) => `${(i % 8) * 1.5} ${Math.floor(i / 8) * 2.25} ${(i % 5) * 0.4}`);
  const text = rows.join('\n') + '\n';
  await drop(page, [...new TextEncoder().encode(text)], 'points');
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.olv-toast-error')).toHaveCount(0);
  await expect(page.locator('.olv-pc-notice')).toHaveText(
    'Opened as XYZ text from its content. Check the columns and units.',
    { timeout: 10_000 },
  );
  await page.locator('summary', { hasText: 'Provenance' }).click();
  await expect(page.locator('.olv-provenance .olv-prov-signal').filter({ hasText: 'interpretation level PROBABLE' }))
    .toBeVisible({ timeout: 10_000 });
});
