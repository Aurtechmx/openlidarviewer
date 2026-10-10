import { test, expect, type Page } from '@playwright/test';
import { activate, dropDenseGridPly } from './helpers';

/**
 * tests/e2e/phoneMeasureHint.spec.ts
 *
 * On a phone the Measure and Inspect instruction is a compact status line:
 * visible with the state text, a polite live region, clear of the tool rail,
 * its buttons, the Inspect bar and the Done button, and gone after exit.
 */

const LINE = '.olv-measure-phone-hint:not(.olv-hidden)';

async function openScan(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
}

/** Bounding boxes of the line and each named surface; asserts no intersection. */
async function expectClearOf(page: Page, others: string[]): Promise<void> {
  const res = await page.evaluate(({ line, others }) => {
    const box = (e: Element) => e.getBoundingClientRect();
    const a = box(document.querySelector(line)!);
    const hits: string[] = [];
    for (const sel of others) {
      for (const n of Array.from(document.querySelectorAll(sel))) {
        const b = box(n);
        if (b.width === 0 || b.height === 0) continue;
        const overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        if (overlap) hits.push(sel);
      }
    }
    return { hits, right: a.right, left: a.left, w: window.innerWidth };
  }, { line: LINE, others });
  expect(res.hits).toEqual([]);
  expect(res.left).toBeGreaterThanOrEqual(0);
  expect(res.right).toBeLessThanOrEqual(res.w);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
  test.describe(`phone measurement instruction ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    for (const kind of ['Distance', 'Area']) {
      test(`${kind} shows a polite instruction clear of the rail`, async ({ page }) => {
        await openScan(page);
        await activate(page.locator('.olv-tool', { hasText: 'Measure' }));
        await expect(page.locator('.olv-measure-bar:not(.olv-hidden)')).toBeVisible();
        const tool = page.locator('.olv-measure-bar .olv-mkind', { hasText: kind });
        if (!(await tool.evaluate((n) => n.classList.contains('olv-mkind-active')))) await activate(tool);
        const line = page.locator(LINE);
        await expect(line).toBeVisible();
        await expect(line).toHaveText(/\S/);
        await expect(line).toHaveAttribute('role', 'status');
        await expect(line).toHaveAttribute('aria-live', 'polite');
        // The line mirrors the in-rail hint text, which stays hidden on phones.
        const text = (await page.locator('.olv-measure-bar .olv-measure-hint-text').textContent())?.trim();
        await expect(line).toHaveText(text ?? '');
        await expectClearOf(page, [
          '.olv-measure-bar',
          '.olv-measure-bar button',
          '.olv-measure-done',
        ]);
        await activate(page.locator('.olv-measure-bar .olv-measure-done'));
        await expect(page.locator(LINE)).toHaveCount(0);
      });
    }

    test('Inspect shows a polite instruction clear of its bar and Done', async ({ page }) => {
      await openScan(page);
      await activate(page.locator('.olv-tool', { hasText: 'Inspect' }));
      const line = page.locator(LINE);
      await expect(line).toBeVisible();
      await expect(line).toHaveText(/\S/);
      await expect(line).toHaveAttribute('role', 'status');
      await expect(line).toHaveAttribute('aria-live', 'polite');
      await expectClearOf(page, ['.olv-measure-hint', '.olv-measure-hint .olv-measure-done']);
      await activate(page.locator('.olv-measure-hint .olv-measure-done'));
      await expect(page.locator(LINE)).toHaveCount(0);
    });
  });
}
