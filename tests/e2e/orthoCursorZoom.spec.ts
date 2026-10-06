/**
 * orthoCursorZoom.spec.ts
 *
 * In the orthographic projection (and in Plan view, which is orthographic from
 * the top) a wheel zoom, a trackpad pinch and a touch pinch must keep the point
 * under the cursor under the cursor. The probe reads the point the viewer's own
 * picker finds under a pixel; this spec reads it at an off-centre pixel, zooms
 * there several times, reads it again at the same pixel and compares the two.
 *
 * An orthographic zoom about a fixed pixel scales every point's screen offset
 * from that pixel by the same factor, so the picker's ranking of nearby points
 * does not change: the same point comes back. A zoom that lets the image slide
 * returns a different point once the slide passes the point spacing.
 * tests/orthoZoomAnchor.test.ts measures the slide in pixels.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  dropDenseGridPly,
  dropTerrainAccessUtmLas,
  pinNavigationPanel,
  waitForCameraSettled,
} from './helpers';

interface Hover {
  index: number;
  x: number;
  y: number;
  z: number;
}

interface Pose {
  position: number[];
  target: number[];
}

async function pose(page: Page): Promise<Pose> {
  return page.evaluate(() => {
    const api = (window as unknown as {
      __OLV_TEST_API__?: { getCameraPose?: () => Pose };
    }).__OLV_TEST_API__;
    const p = api?.getCameraPose?.();
    if (!p) throw new Error('no pose oracle: is the page on ?test=1?');
    return { position: [...p.position], target: [...p.target] };
  });
}

function distance(p: Pose): number {
  return Math.hypot(
    p.position[0] - p.target[0],
    p.position[1] - p.target[1],
    p.position[2] - p.target[2],
  );
}

/** Record every probe hover on the page so the spec can read the latest. */
async function listenForHover(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __orthoHover: Hover | null };
    w.__orthoHover = null;
    window.addEventListener('olv:probe-hover', (e) => {
      const d = (e as CustomEvent<Hover | null>).detail;
      w.__orthoHover = d ? { index: d.index, x: d.x, y: d.y, z: d.z } : null;
    });
  });
}

/** Hover the canvas pixel (px, py), arriving from a neighbour, and return the probed point. */
async function probeAt(page: Page, px: number, py: number): Promise<Hover | null> {
  const box = (await page.locator('.olv-canvas').boundingBox())!;
  await page.evaluate(() => {
    (window as unknown as { __orthoHover: Hover | null }).__orthoHover = null;
  });
  await page.mouse.move(box.x + px + 3, box.y + py + 3);
  await page.mouse.move(box.x + px, box.y + py);
  // The probe resolves on the next frames; wait for a fresh reading.
  for (let i = 0; i < 12; i++) {
    const h = await page.evaluate(() => (window as unknown as { __orthoHover: Hover | null }).__orthoHover);
    if (h) return h;
    await page.waitForTimeout(50);
  }
  return null;
}

/**
 * An off-centre pixel where the probe finds a point, searched outward from
 * (fx, fy). The opening layout can still move the image for a moment after a
 * scan opens (the lens shift refits as the chrome settles), so the hit only
 * counts once the same point has stayed under the pixel for a second.
 */
async function findProbedPixel(page: Page, fx: number, fy: number): Promise<{ px: number; py: number; hit: Hover }> {
  const box = (await page.locator('.olv-canvas').boundingBox())!;
  for (let k = 0; k < 36; k++) {
    const px = Math.round(box.width * fx + 4 * ((k % 6) - 3));
    const py = Math.round(box.height * fy + 4 * (Math.floor(k / 6) - 3));
    let hit = await probeAt(page, px, py);
    if (!hit) continue;
    for (let tries = 0; tries < 10; tries++) {
      await page.waitForTimeout(500);
      const again = await probeAt(page, px, py);
      if (again?.index === hit.index) {
        await page.waitForTimeout(500);
        const third = await probeAt(page, px, py);
        if (third?.index === hit.index) return { px, py, hit };
      }
      if (!again) break;
      hit = again;
    }
  }
  throw new Error('the probe found no steady point near the chosen pixel');
}

/**
 * The two up-axis conventions: the PLY grid opens Y-up (its file names no
 * frame), the georeferenced LAS grid opens Z-up.
 */
async function openScan(page: Page, scan: 'ply-y-up' | 'las-z-up'): Promise<void> {
  await pinNavigationPanel(page);
  await page.goto('/?test=1');
  if (scan === 'ply-y-up') await dropDenseGridPly(page);
  else await dropTerrainAccessUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await waitForCameraSettled(page);
}

type Entry = 'ortho' | 'ortho-iso' | 'plan';

/**
 * Orthographic from the opening framing (which keeps its lens shift), from an
 * oblique Iso view, or Plan view (orthographic from the top). The navigation
 * panel is closed afterwards so it does not cover the pixels the spec hovers.
 */
async function enterOrthographic(page: Page, how: Entry): Promise<void> {
  const row = page.locator('.olv-cam-views');
  const ortho = row.locator('.olv-ortho-toggle');
  if (how === 'plan') {
    await row.locator('.olv-plan-toggle').click();
  } else {
    if (how === 'ortho-iso') {
      await page.locator('.olv-cam-presets .olv-cam-chip', { hasText: /^Iso$/ }).click();
      await waitForCameraSettled(page);
    }
    await ortho.click();
  }
  await expect(ortho).toHaveAttribute('aria-pressed', 'true');
  await waitForCameraSettled(page);
  await page.locator('.olv-nav-hud-close').click();
}

/** Turn the probe tool on or off. A touch gesture reaches the camera only with no tool on. */
async function toggleProbe(page: Page): Promise<void> {
  await page.locator('.olv-dock .olv-tool', { hasText: 'Probe' }).click();
}

async function startProbe(page: Page): Promise<void> {
  await listenForHover(page);
  await toggleProbe(page);
}

/** Two synthesized touch pointers spreading apart about the canvas pixel (cx, cy). */
async function touchSpread(page: Page, cx: number, cy: number, from: number, to: number): Promise<void> {
  await page.evaluate(async ([cx, cy, from, to]) => {
    const canvas = document.querySelector('.olv-canvas') as HTMLElement;
    const rect = canvas.getBoundingClientRect();
    const fire = (type: string, id: number, x: number, y: number): void => {
      const ev = new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch',
        clientX: rect.left + x, clientY: rect.top + y, isPrimary: id === 2001,
      });
      Object.defineProperty(ev, 'offsetX', { get: () => x });
      Object.defineProperty(ev, 'offsetY', { get: () => y });
      canvas.dispatchEvent(ev);
    };
    fire('pointerdown', 2001, cx - from, cy);
    fire('pointerdown', 2002, cx + from, cy);
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const r = from + ((to - from) * i) / steps;
      fire('pointermove', 2001, cx - r, cy);
      fire('pointermove', 2002, cx + r, cy);
      await new Promise((res) => requestAnimationFrame(res));
    }
    fire('pointerup', 2001, cx - to, cy);
    fire('pointerup', 2002, cx + to, cy);
  }, [cx, cy, from, to] as const);
}

test.describe('orthographic zoom keeps the point under the cursor', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.describe.configure({ timeout: 90_000 });

  const CASES = [
    { how: 'ortho-iso', scan: 'ply-y-up', wheelAt: [0.4, 0.6], pinchAt: [0.62, 0.52] },
    { how: 'plan', scan: 'las-z-up', wheelAt: [0.29, 0.17], pinchAt: [0.72, 0.8] },
    { how: 'ortho', scan: 'las-z-up', wheelAt: [0.33, 0.25], pinchAt: [0.65, 0.22] },
  ] as const;

  for (const c of CASES) {
    test(`${c.how} (${c.scan}): wheel zoom at an off-centre pixel`, async ({ page }) => {
      await openScan(page, c.scan);
      await enterOrthographic(page, c.how);
      await startProbe(page);
      const { px, py, hit } = await findProbedPixel(page, c.wheelAt[0], c.wheelAt[1]);
      const before = distance(await pose(page));

      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(60);
      }
      await waitForCameraSettled(page);
      expect(distance(await pose(page))).toBeLessThan(before * 0.85);

      const after = await probeAt(page, px, py);
      expect(after, 'the probe still finds a point under the pixel').not.toBeNull();
      expect(after!.index).toBe(hit.index);

      // And back out: the same point is still there.
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(60);
      }
      await waitForCameraSettled(page);
      const back = await probeAt(page, px, py);
      expect(back?.index).toBe(hit.index);
    });

    test(`${c.how} (${c.scan}): trackpad pinch at an off-centre pixel`, async ({ page }) => {
      await openScan(page, c.scan);
      await enterOrthographic(page, c.how);
      await startProbe(page);
      const { px, py, hit } = await findProbedPixel(page, c.pinchAt[0], c.pinchAt[1]);
      const before = distance(await pose(page));
      const box = (await page.locator('.olv-canvas').boundingBox())!;
      // A macOS pinch reaches the page as small ctrlKey wheels, with no key held.
      await page.evaluate(async ([x, y]) => {
        const canvas = document.querySelector('.olv-canvas') as HTMLElement;
        for (let i = 0; i < 80; i++) {
          canvas.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, deltaY: -4, deltaMode: 0, ctrlKey: true, clientX: x, clientY: y,
          }));
          await new Promise((r) => requestAnimationFrame(r));
        }
      }, [box.x + px, box.y + py] as const);
      await waitForCameraSettled(page);
      expect(distance(await pose(page))).toBeLessThan(before * 0.9);
      const after = await probeAt(page, px, py);
      expect(after?.index).toBe(hit.index);
    });
  }

  const TOUCH = [
    { how: 'ortho-iso', scan: 'ply-y-up', at: [0.6, 0.62] },
    { how: 'ortho', scan: 'las-z-up', at: [0.65, 0.22] },
  ] as const;

  for (const c of TOUCH) {
    test(`${c.how} (${c.scan}): touch pinch about an off-centre midpoint`, async ({ page }) => {
      await openScan(page, c.scan);
      await enterOrthographic(page, c.how);
      await startProbe(page);
      const { px, py, hit } = await findProbedPixel(page, c.at[0], c.at[1]);
      const before = distance(await pose(page));
      await toggleProbe(page);
      await touchSpread(page, px, py, 60, 150);
      await waitForCameraSettled(page);
      expect(distance(await pose(page))).toBeLessThan(before * 0.85);
      await toggleProbe(page);
      const after = await probeAt(page, px, py);
      expect(after?.index).toBe(hit.index);
    });
  }
});
