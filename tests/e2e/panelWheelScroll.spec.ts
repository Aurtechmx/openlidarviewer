import { test, expect, type Page } from '@playwright/test';
import { dropTerrainAccessUtmLas } from './helpers';

/**
 * panelWheelScroll.spec.ts: a wheel or two-finger trackpad gesture over a side
 * panel scrolls that panel and never moves the camera.
 *
 * The right rail is the scroller for the Inspector column. The Inspector card
 * inside it kept its standalone `overflow-y: auto` and `overscroll-behavior:
 * contain`, so it was a scroll container that never overflowed: the gesture
 * latched onto it, had nothing to scroll, and was not passed on to the rail.
 * The left rail's mode body is the control. Neither gesture may reach the
 * canvas, where the camera's wheel zoom listens.
 */

async function scrollTopOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((el) => el.scrollTop);
}

async function wheelOver(page: Page, scroller: string, probe: string): Promise<number> {
  // A point inside both the probe and the visible part of the scroller.
  const [x, y] = await page.evaluate(([s, p]) => {
    const a = document.querySelector(s)!.getBoundingClientRect();
    const b = document.querySelector(p)!.getBoundingClientRect();
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);
    return [b.left + b.width / 2, top + Math.min((bottom - top) / 2, 80)];
  }, [scroller, probe]);
  const hit = await page.evaluate(([px, py, p]) => document.querySelector(p)!.contains(document.elementFromPoint(px, py)), [x, y, probe] as const);
  expect(hit, `the pointer is over ${probe}`).toBe(true);
  await page.mouse.move(x, y);
  const before = await scrollTopOf(page, scroller);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => scrollTopOf(page, scroller), { message: `${scroller} scrolls under the wheel`, timeout: 3_000 })
    .toBeGreaterThan(before);
  return scrollTopOf(page, scroller);
}

test('a wheel over either side panel scrolls the panel, not the camera', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto('/?test=1');
  await dropTerrainAccessUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });

  // Long content in both rails.
  await page.locator('.olv-right-rail details').evaluateAll((ds) => ds.forEach((d) => { (d as HTMLDetailsElement).open = true; }));
  const rail = await page.locator('.olv-right-rail').evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(rail.sh, 'the right rail has content to scroll').toBeGreaterThan(rail.ch + 200);

  // The camera's wheel zoom listens on the canvas. Record every wheel event the
  // canvas sees; a wheel over a panel must never be one of them. The camera pose
  // itself is not compared: the load fly-in keeps moving it for several seconds
  // on a software renderer, independent of any input.
  await page.locator('canvas.olv-canvas').evaluate((c) => {
    const w = window as unknown as { __canvasWheels: number };
    w.__canvasWheels = 0;
    c.addEventListener('wheel', () => { w.__canvasWheels++; }, { capture: true, passive: true });
  });
  const canvasWheels = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __canvasWheels: number }).__canvasWheels);

  // Over the Inspector card itself, which is where the gesture used to stop.
  await wheelOver(page, '.olv-right-rail', '.olv-right-rail > .olv-inspector');
  expect(await canvasWheels(), 'a wheel over the right rail reached the camera').toBe(0);

  // Scrolled content stays inside the rail, below the header row.
  const headerBottom = await page.locator('.olv-topbar > .olv-loc').evaluate((e) => e.getBoundingClientRect().bottom);
  const railTop = await page.locator('.olv-right-rail').evaluate((e) => e.getBoundingClientRect().top);
  expect(railTop).toBeGreaterThanOrEqual(headerBottom);

  // Control: the left rail's mode body, given a spacer so it has something to scroll.
  await page.locator('.olv-ws-body').evaluate((el) => {
    const spacer = document.createElement('div');
    spacer.style.height = '2000px';
    const shown = [...el.querySelectorAll<HTMLElement>('.olv-ws-mode')].find((m) => m.offsetParent !== null);
    (shown ?? el).append(spacer);
  });
  const left = await page.locator('.olv-ws-body').evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(left.sh, 'the left rail body has content to scroll').toBeGreaterThan(left.ch + 20);
  await wheelOver(page, '.olv-ws-body', '.olv-ws-body');

  expect(await canvasWheels(), 'a wheel over the left rail reached the camera').toBe(0);

  // The probe itself works: a wheel over open canvas does reach it.
  const [cx, cy] = await page.evaluate(() => {
    for (let y = 650; y > 100; y -= 25) for (let x = 400; x < 1000; x += 50) {
      if (document.elementFromPoint(x, y)?.classList.contains('olv-canvas')) return [x, y];
    }
    return [0, 0];
  });
  expect(cx, 'an open patch of canvas').toBeGreaterThan(0);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 120);
  await expect.poll(canvasWheels).toBeGreaterThan(0);
});
