import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { activate, railChromeSettled } from './helpers';

/**
 * Compare elevation runs on the chosen Before and After clouds, not on load
 * order. Three clouds are loaded; the first and third are compared.
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

test('compares the chosen first and third of three clouds', async ({ page }) => {
  await page.goto('/?test=1');
  await drop(page, 'epoch-one.las');
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await drop(page, 'epoch-two.las');
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  await drop(page, 'epoch-three.las');
  await expect(page.locator('.olv-layer')).toHaveCount(3, { timeout: 20_000 });
  await railChromeSettled(page);

  const before = page.locator('select.olv-compare-before');
  const after = page.locator('select.olv-compare-after');
  await expect(before.locator('option')).toHaveCount(3);
  const ids = await before.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

  const compare = page.locator('.olv-layer-compare', { hasText: 'Compare elevation' });
  const result = page.locator('.olv-layer-compare-result');

  await before.selectOption(ids[1]);
  await after.selectOption(ids[1]);
  await compare.scrollIntoViewIfNeeded();
  await activate(compare);
  await expect(result).toContainText('Before and After are the same cloud');

  await before.selectOption(ids[0]);
  await after.selectOption(ids[2]);
  await activate(compare);
  await expect(result).toContainText('epoch-one (before) → epoch-three (after)', { timeout: 20_000 });
});
