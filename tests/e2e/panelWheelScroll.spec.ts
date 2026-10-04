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
 * The left rail's mode body is the control.
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

  const pose = (): Promise<unknown> => page.evaluate(() => (window as unknown as {
    __OLV_TEST_API__: { getCameraPose: () => unknown };
  }).__OLV_TEST_API__.getCameraPose());
  // The camera settles after the scan frames itself; compare from rest.
  const settledPose = async (): Promise<string> => {
    let last = '';
    await expect.poll(async () => {
      const now = JSON.stringify(await pose());
      const same = now === last;
      last = now;
      return same;
    }, { intervals: [300], timeout: 10_000 }).toBe(true);
    return last;
  };

  // Over the Inspector card itself, which is where the gesture used to stop.
  let poseBefore = await settledPose();
  await wheelOver(page, '.olv-right-rail', '.olv-right-rail > .olv-inspector');
  expect(JSON.stringify(await pose()), 'a wheel over the right rail moved the camera').toBe(poseBefore);

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
  poseBefore = await settledPose();
  const left = await page.locator('.olv-ws-body').evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(left.sh, 'the left rail body has content to scroll').toBeGreaterThan(left.ch + 20);
  await wheelOver(page, '.olv-ws-body', '.olv-ws-body');

  expect(JSON.stringify(await pose()), 'a wheel over the left rail moved the camera').toBe(poseBefore);
});
