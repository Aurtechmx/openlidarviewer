import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, suppressOnboardingTour } from './helpers';

/**
 * Opening a scan from the empty state clears the splash before the load toast
 * shows, so the toast never sits on the brand mark (both use the top-centre
 * lane). File reads are held behind a gate so the busy state lasts as long as
 * the test needs; releasing it lets the load run to its first frame.
 */

async function holdReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __release: () => void; __gate: Promise<void> };
    w.__gate = new Promise<void>((r) => { w.__release = r; });
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (this: Blob) {
      return w.__gate.then(() => read.call(this));
    };
  });
}

/** Per frame: opacity of the hero and of the toast as painted (ancestors included). */
async function sampleFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: Array<{ hero: number; toast: number }> };
    w.__frames = [];
    const painted = (el: Element | null): number => {
      let o = 1;
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
        o *= Number(cs.opacity);
      }
      return el ? o : 0;
    };
    const tick = (): void => {
      w.__frames.push({ hero: painted(document.querySelector('.olv-empty-hero-mark')), toast: painted(document.querySelector('.olv-toast')) });
      if (w.__frames.length < 600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Visible elements of the empty state whose box meets the toast's box. */
function overlapsToast(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const t = document.querySelector('.olv-toast')!.getBoundingClientRect();
    const hits: string[] = [];
    for (const el of Array.from(document.querySelectorAll('.olv-empty *'))) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top) hits.push(el.className.toString() || el.tagName);
    }
    return hits;
  });
}

for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`the splash clears before the load status shows, nothing overlaps it, and the scan opens (${size.width}px)`, async ({ page }) => {
    await page.setViewportSize(size);
    await suppressOnboardingTour(page);
    await holdReads(page);
    await page.goto('/?test=1');
    await expect(page.locator('.olv-empty-hero-mark')).toBeVisible();
    await sampleFrames(page);
    await dropDenseGridPly(page);

    const toast = page.locator('.olv-toast');
    await expect(toast).toHaveClass(/is-busy/);
    await expect.poll(() => toast.evaluate((e) => Number(getComputedStyle(e).opacity))).toBe(1);
    expect(await overlapsToast(page)).toEqual([]);
    await expect(page.locator('.olv-empty-hero')).toHaveCSS('visibility', 'hidden');

    const frames = await page.evaluate(() => (window as unknown as { __frames: Array<{ hero: number; toast: number }> }).__frames);
    const first = frames.findIndex((f) => f.toast > 0.02);
    expect(first, 'the toast appeared').toBeGreaterThan(-1);
    for (const f of frames.slice(first)) expect(f.hero, 'the mark is gone whenever the status shows').toBeLessThan(0.02);

    await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    // First frame: the scan is listed and the viewer has drawn a frame since.
    await expect(page.getByText('dense-grid.ply').first()).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(toast).toBeHidden({ timeout: 20_000 });
  });
}

test('a failed open brings the splash straight back', async ({ page }) => {
  await suppressOnboardingTour(page);
  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty-hero-mark')).toBeVisible();
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(64)], 'broken.ply'));
    return dt;
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await expect(page.locator('.olv-toast')).toHaveClass(/olv-toast-error/, { timeout: 20_000 });
  await expect(page.locator('.olv-empty-hero')).toHaveCSS('visibility', 'visible');
  await expect(page.locator('.olv-empty-hero')).toHaveCSS('opacity', '1');
});

test('under reduced motion the splash clears and the status shows with no animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await suppressOnboardingTour(page);
  await holdReads(page);
  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty-hero-mark')).toBeVisible();
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-toast')).toHaveClass(/is-busy/);
  // One frame later: the app's reduced-motion floor shortens any remaining
  // transition to 0.01 ms, so only real motion (longer than 1 ms) is counted.
  const state = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const toast = document.querySelector('.olv-toast')!;
    const empty = document.querySelector('.olv-empty')!;
    const moving = document.getAnimations().filter((a) => {
      const t = (a.effect as KeyframeEffect | null)?.target;
      const ms = Number(a.effect?.getComputedTiming().duration ?? 0);
      return ms > 1 && t instanceof Element && (t === toast || t === empty || t.parentElement === empty);
    });
    return {
      hero: getComputedStyle(document.querySelector('.olv-empty-hero')!).visibility,
      toast: getComputedStyle(toast).opacity,
      moving: moving.map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty} on ${((a.effect as KeyframeEffect).target as Element).className}`),
    };
  });
  expect(state).toEqual({ hero: 'hidden', toast: '1', moving: [] });
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
});
