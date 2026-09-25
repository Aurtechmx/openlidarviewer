/**
 * viewerFloor.ts — shared probes for the compatibility-floor specs
 * (webgl2Path, capabilityDeprivation): open a scan, prove the canvas drew it,
 * prove an orbit drag moved the camera, and collect uncaught page errors.
 */

import { expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';
import { isBenignPageError } from './pageErrors';

/** Collect uncaught page errors, minus benign engine notifications. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    if (!isBenignPageError(e.message)) errors.push(e.message);
  });
  return errors;
}

/** Open the viewer on `/?test=1<extra>`, drop tiny.ply, and wait for the scan to attach. */
export async function bootAndOpenTiny(page: Page, extraQuery = ''): Promise<void> {
  await page.goto(`/?test=1${extraQuery}`);
  await expect(page.locator('.olv-canvas')).toBeVisible({ timeout: 20_000 });
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
}

/** The backend the app reports in the tool dock ("WebGPU" / "WebGL 2"). */
export async function reportedBackend(page: Page): Promise<string> {
  const text = page.locator('.olv-backend-text');
  await expect(text).not.toHaveText(/initialising/, { timeout: 20_000 });
  return ((await text.textContent()) ?? '').trim();
}

/**
 * Count canvas pixels that differ from the dominant (background) colour. The
 * screenshot is decoded in the page with a 2D canvas, so no PNG library is
 * needed and the check reads what was composited, whatever the backend.
 */
export async function drawnPixelCount(page: Page): Promise<number> {
  const png = await page.locator('.olv-canvas').screenshot();
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d');
    if (!ctx) return -1;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < d.length; i += 4) {
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let bg = 0;
    let bgCount = -1;
    for (const [k, n] of counts) if (n > bgCount) { bg = k; bgCount = n; }
    const br = (bg >> 16) & 255, bgg = (bg >> 8) & 255, bb = bg & 255;
    let drawn = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgg) + Math.abs(d[i + 2] - bb) > 48) drawn++;
    }
    return drawn;
  }, png.toString('base64'));
}

/** Wait until the drawn-pixel count is non-trivial (the scan reached the screen). */
export async function expectDrawn(page: Page): Promise<void> {
  await expect.poll(() => drawnPixelCount(page), { timeout: 15_000, intervals: [250, 500, 1000] })
    .toBeGreaterThan(8);
}

async function readPose(page: Page): Promise<string> {
  const pose = await page.evaluate(() => {
    const api = (window as unknown as {
      __OLV_TEST_API__?: { getCameraPose?: () => { position: number[]; target: number[] } };
    }).__OLV_TEST_API__;
    const p = api?.getCameraPose?.();
    return p ? JSON.stringify(p.position) : '';
  });
  expect(pose, 'test-seam pose oracle read nothing').not.toBe('');
  return pose;
}

/** Wait for the framing tween to stop, then return the settled camera position. */
async function settledPose(page: Page): Promise<string> {
  let last = await readPose(page);
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(150);
    const next = await readPose(page);
    if (next === last) return next;
    last = next;
  }
  throw new Error('the camera never settled');
}

/**
 * Drag across the canvas and prove the camera moved: a primary-button mouse
 * drag, or (for a touch device) a two-finger touch twist dispatched on the canvas.
 */
export async function expectOrbitMovesCamera(page: Page, input: 'mouse' | 'touch' = 'mouse'): Promise<void> {
  const before = await settledPose(page);
  const box = await page.locator('.olv-canvas').boundingBox();
  if (!box) throw new Error('no canvas bounding box');
  if (input === 'touch') {
    // A two-finger twist through the Viewer's own touch recogniser.
    await page.evaluate(async () => {
      const canvas = document.querySelector('.olv-canvas') as HTMLElement;
      // The synthetic ids have no active pointer, so the browser refuses to
      // capture or release them; a real finger's id always can be. Only these two ids are
      // excused, so a capture failure on any real pointer still surfaces.
      const capture = canvas.setPointerCapture.bind(canvas);
      const release = canvas.releasePointerCapture.bind(canvas);
      const real = (id: number) => id !== 3001 && id !== 3002;
      canvas.setPointerCapture = (id: number) => { if (real(id)) capture(id); };
      canvas.releasePointerCapture = (id: number) => { if (real(id)) release(id); };
      const rect = canvas.getBoundingClientRect();
      const fire = (type: string, id: number, x: number, y: number) => {
        const ev = new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch',
          clientX: rect.left + x, clientY: rect.top + y, isPrimary: id === 3001,
        });
        Object.defineProperty(ev, 'offsetX', { get: () => x });
        Object.defineProperty(ev, 'offsetY', { get: () => y });
        canvas.dispatchEvent(ev);
      };
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const r = Math.min(rect.width, rect.height) / 3;
      fire('pointerdown', 3001, cx - r, cy);
      fire('pointerdown', 3002, cx + r, cy);
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const t = (i / steps) * (Math.PI / 2);
        fire('pointermove', 3001, cx - r * Math.cos(t), cy - r * Math.sin(t));
        fire('pointermove', 3002, cx + r * Math.cos(t), cy + r * Math.sin(t));
        await new Promise((res) => setTimeout(res, 12));
      }
      fire('pointerup', 3001, cx, cy - r);
      fire('pointerup', 3002, cx, cy + r);
      await new Promise((res) => setTimeout(res, 100));
      delete (canvas as { setPointerCapture?: unknown }).setPointerCapture;
      delete (canvas as { releasePointerCapture?: unknown }).releasePointerCapture;
    });
  } else {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x + i * 12, y + i * 4);
    await page.mouse.up();
  }
  await expect.poll(() => readPose(page), { timeout: 5_000 }).not.toBe(before);
}
