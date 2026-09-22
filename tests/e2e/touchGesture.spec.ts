import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * tests/e2e/touchGesture.spec.ts
 *
 * Coverage for the v0.3.7 mobile touch-gesture model (D.7).
 *
 *   - A 2-pointer twist moves the camera (share-link pose changes).
 *   - A tiny sub-threshold 2-pointer wobble does NOT move the camera
 *     (dead-zone proof).
 *   - The Inspector "Touch twist" chip toggles active/inactive and
 *     persists via localStorage so a reload restores the choice.
 *
 * Touch event simulation: Playwright doesn't expose a native multi-touch
 * gesture API, so the spec dispatches synthesized `PointerEvent`s with
 * `pointerType: 'touch'` and matching pointerIds. The Viewer's recogniser
 * reads these the same way it would read real fingers.
 */


/**
 * Dispatch a synthesized two-finger gesture. `fromA, fromB` are the
 * starting canvas-local pixel positions of each finger; `toA, toB` are
 * their final positions. The recogniser sees one pointerdown per finger,
 * a series of pointermove pairs along the segment, then pointerup.
 */
async function twoFingerGesture(
  page: Page,
  fromA: { x: number; y: number },
  fromB: { x: number; y: number },
  toA: { x: number; y: number },
  toB: { x: number; y: number },
  steps = 12,
): Promise<void> {
  await page.evaluate(
    async ([fromA, fromB, toA, toB, steps]) => {
      const canvas = document.querySelector('.olv-canvas') as HTMLElement | null;
      if (!canvas) throw new Error('no canvas');
      const rect = canvas.getBoundingClientRect();
      const aId = 1001;
      const bId = 1002;
      const fire = (target: HTMLElement, type: string, id: number, x: number, y: number) => {
        const ev = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          pointerType: 'touch',
          clientX: rect.left + x,
          clientY: rect.top + y,
          isPrimary: id === aId,
        });
        Object.defineProperty(ev, 'offsetX', { get: () => x });
        Object.defineProperty(ev, 'offsetY', { get: () => y });
        target.dispatchEvent(ev);
      };
      fire(canvas, 'pointerdown', aId, fromA.x, fromA.y);
      fire(canvas, 'pointerdown', bId, fromB.x, fromB.y);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ax = fromA.x + (toA.x - fromA.x) * t;
        const ay = fromA.y + (toA.y - fromA.y) * t;
        const bx = fromB.x + (toB.x - fromB.x) * t;
        const by = fromB.y + (toB.y - fromB.y) * t;
        fire(canvas, 'pointermove', aId, ax, ay);
        fire(canvas, 'pointermove', bId, bx, by);
        await new Promise((r) => setTimeout(r, 12));
      }
      fire(canvas, 'pointerup', aId, toA.x, toA.y);
      fire(canvas, 'pointerup', bId, toB.x, toB.y);
    },
    [fromA, fromB, toA, toB, steps] as const,
  );
}

/**
 * Dispatch a synthesized single-finger tap at a canvas-local pixel position:
 * one pointerdown immediately followed by a pointerup, no move between them.
 */
async function singleTap(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ([x, y]) => {
      const canvas = document.querySelector('.olv-canvas') as HTMLElement | null;
      if (!canvas) throw new Error('no canvas');
      const rect = canvas.getBoundingClientRect();
      const id = 2001;
      const fire = (type: string) => {
        const ev = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          pointerType: 'touch',
          clientX: rect.left + x,
          clientY: rect.top + y,
          isPrimary: true,
        });
        Object.defineProperty(ev, 'offsetX', { get: () => x });
        Object.defineProperty(ev, 'offsetY', { get: () => y });
        canvas.dispatchEvent(ev);
      };
      fire('pointerdown');
      fire('pointerup');
    },
    [x, y] as const,
  );
}

/**
 * Read the camera pose through the test seam.
 *
 * This used to read a share link off the clipboard, which is why the three
 * pose tests ran on Chromium alone. The reason was measured rather than
 * assumed: only Chromium grants `clipboard-read` under Playwright, and the
 * app's address-bar fallback fires only when `clipboard.writeText` REJECTS.
 * On WebKit that write resolves, so nothing lands in the address bar either;
 * the oracle read nothing and the tests failed on the empty-oracle guard,
 * never reaching the gesture they exist to verify.
 *
 * `__OLV_TEST_API__` needs neither the clipboard nor the desktop dock, so the
 * same pose is readable on every engine. The recogniser under test is
 * unchanged; only how its result is observed has moved. The page must be on
 * `?test=1` and the build must carry `OLV_TEST_SEAM`, which the Playwright
 * webServer sets.
 *
 * The pose is REQUIRED, not defaulted. A blind oracle returning the same empty
 * value twice would make a "did not move" assertion pass for the wrong reason,
 * which is worse than not running the test at all.
 */
async function readPose(page: Page): Promise<string> {
  const pose = await page.evaluate(() => {
    const api = (window as unknown as {
      __OLV_TEST_API__?: { getCameraPose?: () => { position: number[]; target: number[] } };
    }).__OLV_TEST_API__;
    const p = api?.getCameraPose?.();
    return p ? JSON.stringify({ position: p.position, target: p.target }) : '';
  });
  expect(
    pose,
    'test-seam pose oracle read nothing - is the page on ?test=1 and the build carrying OLV_TEST_SEAM?',
  ).not.toBe('');
  return pose;
}

test.describe('mobile touch model — twist + pinch + pan decomposition', () => {
  test('a single-finger double-tap focuses the camera on a point (dblclick does not fire on touch)', async ({
    page,
  }) => {
    await page.goto('/?test=1');
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(1500);

    const before = await readPose(page);

    // Two quick taps at the centre, where the dropped cloud sits — the touch
    // double-tap the platform's dblclick never delivers on a touch-action:none
    // canvas. It should pick the point under the taps and focus the camera.
    const canvasBox = await page.locator('.olv-canvas').boundingBox();
    if (!canvasBox) throw new Error('no canvas bounding box');
    const cx = canvasBox.width / 2;
    const cy = canvasBox.height / 2;
    await singleTap(page, cx, cy);
    await page.waitForTimeout(80);
    await singleTap(page, cx, cy);
    await page.waitForTimeout(600);

    const after = await readPose(page);
    expect(before).not.toBe('');
    expect(after).not.toBe(before);
  });


  test('a 2-finger twist moves the camera (share-link pose changes)', async ({
    page,
  }) => {
    await page.goto('/?test=1');
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(1500);

    const before = await readPose(page);

    // 90° twist around the centre of the canvas: fingers start on a
    // horizontal axis and finish on a vertical axis, distance unchanged.
    const canvasBox = await page.locator('.olv-canvas').boundingBox();
    if (!canvasBox) throw new Error('no canvas bounding box');
    const cx = canvasBox.width / 2;
    const cy = canvasBox.height / 2;
    const R = 160;
    await twoFingerGesture(
      page,
      { x: cx - R, y: cy },
      { x: cx + R, y: cy },
      { x: cx, y: cy - R },
      { x: cx, y: cy + R },
    );
    await page.waitForTimeout(600);

    const after = await readPose(page);
    expect(before).not.toBe('');
    expect(after).not.toBe(before);
  });

  test('a sub-dead-zone wobble does NOT move the camera', async ({
    page,
  }) => {
    await page.goto('/?test=1');
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(1500);

    const before = await readPose(page);

    // 1° twist, no pinch, no pan — every channel below its dead-zone.
    const canvasBox = await page.locator('.olv-canvas').boundingBox();
    if (!canvasBox) throw new Error('no canvas bounding box');
    const cx = canvasBox.width / 2;
    const cy = canvasBox.height / 2;
    const R = 160;
    const angle = (1 * Math.PI) / 180;
    await twoFingerGesture(
      page,
      { x: cx - R, y: cy },
      { x: cx + R, y: cy },
      { x: cx - R * Math.cos(angle), y: cy + R * Math.sin(angle) },
      { x: cx + R * Math.cos(angle), y: cy - R * Math.sin(angle) },
    );
    await page.waitForTimeout(400);

    const after = await readPose(page);
    expect(after).toBe(before);
  });

  test('Inspector exposes a "Touch twist" chip that toggles', async ({ page }) => {
    await page.goto('/');
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    // v0.3.8: Rendering section is collapsible and default-closed.
    await openRenderingSection(page);

    const chip = page.locator('.olv-chip', { hasText: 'Touch twist' });
    await expect(chip).toBeVisible();
    // Default state: active (standard model on by default).
    await expect(chip).toHaveClass(/olv-chip-active/);

    // Click toggles off.
    await chip.click();
    await expect(chip).not.toHaveClass(/olv-chip-active/);

    // Click again toggles back on.
    await chip.click();
    await expect(chip).toHaveClass(/olv-chip-active/);
  });

  test('Touch-twist preference persists across a page reload', async ({ page }) => {
    await page.goto('/');
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await openRenderingSection(page);

    const chip = page.locator('.olv-chip', { hasText: 'Touch twist' });
    // Turn it off and reload.
    await chip.click();
    await expect(chip).not.toHaveClass(/olv-chip-active/);

    await page.reload();
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await openRenderingSection(page);

    const chipAfter = page.locator('.olv-chip', { hasText: 'Touch twist' });
    await expect(chipAfter).not.toHaveClass(/olv-chip-active/);
  });
});

async function openRenderingSection(page: import('@playwright/test').Page): Promise<void> {
  const renderingDetails = page.locator('details.olv-section-collapsible', {
    has: page.locator('summary', { hasText: 'Rendering' }),
  });

  // At phone width the panels live in a collapsed bottom sheet rather than an
  // always-open side rail, so the summary exists in the DOM but has no layout
  // box. Clicking it there times out on "element is not visible", which reads
  // like the setting is unreachable on a touch device. It is not: the sheet
  // opens and its View tab holds the Rendering section. Verified by hand at
  // 375x812, where the chip is 44 px tall and carries `olv-chip-active`.
  if (!(await renderingDetails.locator('summary').isVisible())) {
    const viewTab = page.locator('.olv-msheet-tab', { hasText: 'View' });
    if (await viewTab.count()) {
      // The sheet starts collapsed; its handle is the chevron beside the tabs.
      if (!(await viewTab.isVisible())) {
        await page.locator('.olv-dock [aria-label*="xpand"], .olv-msheet-handle').first().click();
      }
      await viewTab.click();
      await expect(renderingDetails.locator('summary')).toBeVisible({ timeout: 10_000 });
    }
  }

  const isOpen = await renderingDetails.evaluate((d) =>
    (d as HTMLDetailsElement).open,
  );
  if (!isOpen) await renderingDetails.locator('summary').click();
}
