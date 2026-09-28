/**
 * trackpadWheel.spec.ts
 *
 * A trackpad scroll or pinch reaches the page as a stream of wheel events a
 * few pixels each (a pinch carries ctrlKey). Each event on its own is below
 * the dolly's rest floor; the camera must still follow the stream, and a pinch
 * must not zoom the page. tests/wheelSmallDeltas.test.ts pins the exact sum.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropTinyLas } from './helpers';

async function distance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const api = (window as unknown as {
      __OLV_TEST_API__?: { getCameraPose?: () => { position: number[]; target: number[] } };
    }).__OLV_TEST_API__;
    const p = api?.getCameraPose?.();
    if (!p) throw new Error('no pose oracle: is the page on ?test=1?');
    return Math.hypot(p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]);
  });
}

async function settledDistance(page: Page): Promise<number> {
  let last = await distance(page);
  for (let i = 0; i < 120; i++) {
    await page.evaluate(() => new Promise<void>((r) => {
      let n = 0;
      const tick = (): void => { n += 1; if (n >= 3) r(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }));
    const next = await distance(page);
    if (next === last) return next;
    last = next;
  }
  throw new Error('the camera was still moving');
}

/** Dispatch `count` wheel events of `deltaY` px, one per frame; returns how many were cancelled. */
async function wheelStream(page: Page, deltaY: number, count: number, ctrlKey: boolean): Promise<number> {
  return page.evaluate(async ([deltaY, count, ctrlKey]) => {
    const canvas = document.querySelector('.olv-canvas') as HTMLElement;
    const rect = canvas.getBoundingClientRect();
    let cancelled = 0;
    for (let i = 0; i < count; i++) {
      const ev = new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY, deltaMode: 0, ctrlKey,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      });
      canvas.dispatchEvent(ev);
      if (ev.defaultPrevented) cancelled += 1;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return cancelled;
  }, [deltaY, count, ctrlKey] as const);
}

test.describe('trackpad wheel streams', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?test=1');
    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await expect(page.locator('body.olv-has-scan')).toHaveCount(1, { timeout: 30_000 });
  });

  test('a pinch of small ctrlKey deltas zooms in, and the page does not zoom', async ({ page }) => {
    const before = await settledDistance(page);
    const cancelled = await wheelStream(page, -3, 30, true);
    const after = await settledDistance(page);
    expect(cancelled).toBe(30);
    expect(after).toBeLessThan(before * 0.97);
  });

  test('a slow two-finger scroll of small deltas zooms out', async ({ page }) => {
    const before = await settledDistance(page);
    await wheelStream(page, 2, 30, false);
    const after = await settledDistance(page);
    expect(after).toBeGreaterThan(before * 1.02);
  });
});
