import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { activate, railChromeSettled } from './helpers';

/**
 * Compare elevation leaves Withheld points out of both epochs and says so.
 *
 * `withheld-flags.las` holds 12 points, 3 of them Withheld. Loaded as both
 * epochs, each reads 9 and the compare panel names the counts.
 */

const BYTES = [...readFileSync(fileURLToPath(new URL('../fixtures/withheld-flags.las', import.meta.url)))];

async function drop(page: Page, name: string): Promise<void> {
  const dt = await page.evaluateHandle(
    ({ b, n }) => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array(b)], n));
      return d;
    },
    { b: BYTES, n: name },
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

test('names the Withheld counts for both epochs', async ({ page }) => {
  await page.goto('/?test=1');
  await drop(page, 'epoch-a.las');
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await drop(page, 'epoch-b.las');
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  await railChromeSettled(page);

  const compare = page.locator('.olv-layer-compare', { hasText: 'Compare elevation' });
  await compare.scrollIntoViewIfNeeded();
  await activate(compare);
  const result = page.locator('.olv-layer-compare-result');
  await expect(result).toContainText('Before points: 9 of 12 analysed; Withheld excluded: 3', { timeout: 20_000 });
  await expect(result).toContainText('After points: 9 of 12 analysed; Withheld excluded: 3');
});
