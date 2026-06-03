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

const Z_UP = [0, 0, 1] as const;
void Z_UP;

async function readShareLink(page: Page): Promise<string> {
  // v0.3.10: button label changed from "Share" → "Copy view link" to
  // match the local-first reality. The clipboard contract is identical.
  await page.locator('.olv-tool', { hasText: 'Copy view link' }).click();
  await page.waitForTimeout(200);
  return page.evaluate(() =>
    navigator.clipboard.readText().catch(() => window.location.hash),
  );
}

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

test.describe('mobile touch model — twist + pinch + pan decomposition', () => {
  test('a 2-finger twist moves the camera (share-link pose changes)', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(1500);

    const before = await readShareLink(page);

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

    const after = await readShareLink(page);
    expect(before).not.toBe('');
    expect(after).not.toBe(before);
  });

  test('a sub-dead-zone wobble does NOT move the camera', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(1500);

    const before = await readShareLink(page);

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

    const after = await readShareLink(page);
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
  const isOpen = await renderingDetails.evaluate((d) =>
    (d as HTMLDetailsElement).open,
  );
  if (!isOpen) await renderingDetails.locator('summary').click();
}
