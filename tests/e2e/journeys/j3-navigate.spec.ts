/**
 * J3 Navigate and inspect: zoom anchor, framing, Plan, Frame all, keyboard,
 * reduced motion, and the P3 touch path.
 *
 * The scan is the 30 x 30 m UTM fixture (1 m point spacing, Z-up), so "the
 * point under the cursor stayed put" can be judged against a known spacing.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  cameraPose,
  fixtureBytes,
  openWith,
  probePointUnder,
  projectAllPoints,
  startJourney,
  type Pose,
} from './helpers/journey';
import { framedScanCentre, pinNavigationPanel, waitForCameraSettled } from '../helpers';

const SPACING_M = 1;
const POINTS = 900;

async function openTerrain(page: Page): Promise<void> {
  await pinNavigationPanel(page);
  await openWith(page, fixtureBytes('terrain-access-utm.las'), 'terrain-access-utm.las');
  await waitForCameraSettled(page);
  const dismiss = page.locator('.olv-pc-dismiss');
  if (await dismiss.isVisible()) await dismiss.click();
}

/** Points whose projection falls outside the canvas. */
async function offscreen(page: Page): Promise<number> {
  const box = (await page.locator('.olv-canvas').boundingBox())!;
  const pts = await projectAllPoints(page, POINTS);
  expect(pts.length).toBe(POINTS);
  return pts.filter((p) => p.x < box.x - 1 || p.x > box.x + box.width + 1 || p.y < box.y - 1 || p.y > box.y + box.height + 1).length;
}

/** A pixel off the centre where the probe finds the same point twice in a row. */
async function steadyProbe(page: Page, fx: number, fy: number) {
  const box = (await page.locator('.olv-canvas').boundingBox())!;
  for (let k = 0; k < 25; k++) {
    const px = Math.round(box.width * fx + 6 * ((k % 5) - 2));
    const py = Math.round(box.height * fy + 6 * (Math.floor(k / 5) - 2));
    const a = await probePointUnder(page, px, py);
    if (!a) continue;
    await page.waitForTimeout(300);
    const b = await probePointUnder(page, px, py);
    if (b && b.index === a.index) return { px, py, hit: a };
  }
  throw new Error('no steady probed point near the chosen pixel');
}

/**
 * The hover probe reports only while the Probe tool is on (orthoCursorZoom
 * does the same); the navigation panel is closed so it covers no pixel.
 */
async function setProbe(page: Page, on: boolean): Promise<void> {
  const tool = page.locator('.olv-dock .olv-tool', { hasText: 'Probe' });
  const pressed = (await tool.getAttribute('aria-pressed')) === 'true';
  if (pressed !== on) await tool.click();
}

async function wheelZoomAnchored(page: Page, label: string): Promise<void> {
  await setProbe(page, true);
  const { px, py, hit } = await steadyProbe(page, 0.62, 0.42);
  const box = (await page.locator('.olv-canvas').boundingBox())!;
  await page.mouse.move(box.x + px, box.y + py);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(120);
  }
  await waitForCameraSettled(page);
  const after = await probePointUnder(page, px, py);
  expect(after, `${label}: the probe still finds a point under the cursor`).not.toBeNull();
  const drift = Math.hypot(after!.x - hit.x, after!.y - hit.y, after!.z - hit.z);
  expect(drift, `${label}: point under the cursor moved ${drift.toFixed(2)} m`).toBeLessThanOrEqual(1.5 * SPACING_M);
  await setProbe(page, false);
}

function viewDir(p: Pose): number[] {
  const d = [0, 1, 2].map((a) => p.target[a] - p.position[a]);
  const n = Math.hypot(...d);
  return d.map((c) => c / n);
}

test.describe('J3 navigate (mouse and keyboard)', () => {
  test.skip(() => test.info().project.use.hasTouch === true, 'mouse journey');

  test('P1: wheel zoom keeps the point under the cursor, in perspective and orthographic', async ({ page }, info) => {
    test.setTimeout(120_000);
    const j = startJourney(page, info, 'j3');
    await j.step('open the scan', () => openTerrain(page));
    await j.step('perspective wheel zoom is anchored', () => wheelZoomAnchored(page, 'perspective'));
    await j.step('Frame all brings the whole scan back', async () => {
      await page.getByRole('button', { name: 'Frame all' }).first().click();
      await waitForCameraSettled(page);
      expect(await offscreen(page)).toBe(0);
    });
    await j.step('orthographic wheel zoom is anchored', async () => {
      const ortho = page.getByRole('button', { name: 'Orthographic projection' });
      await ortho.click();
      await expect(ortho).toHaveAttribute('aria-pressed', 'true');
      await waitForCameraSettled(page);
      await wheelZoomAnchored(page, 'orthographic');
    });
  });

  for (const vp of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'portrait', width: 768, height: 1024 },
    { name: 'wide', width: 2560, height: 1080 },
  ]) {
    test(`P1: every standard view keeps the whole scan on screen (${vp.name})`, async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const j = startJourney(page, info, 'j3');
      await j.step('open the scan', () => openTerrain(page));
      for (const view of ['Top view', 'Iso view', 'Front view (axis aligned)', 'Right view (axis aligned)']) {
        await j.step(`${view} frames every point`, async () => {
          const chip = page.getByRole('button', { name: view, exact: true });
          await expect(chip).toBeVisible();
          await chip.click();
          await waitForCameraSettled(page);
          expect(await offscreen(page), `${view} at ${vp.width}x${vp.height}`).toBe(0);
        });
      }
    });
  }

  test('P1: Plan view reads pressed only once the camera looks straight down', async ({ page }, info) => {
    // J3-PLAN: the Plan chip turns aria-pressed (and the "Plan view on" toast
    // shows) only once the camera has landed top-down.
    const j = startJourney(page, info, 'j3');
    await j.step('open the scan', () => openTerrain(page));
    await j.step('Plan view presses only once the camera looks straight down', async () => {
      const plan = page.getByRole('button', { name: 'Plan view' });
      await plan.click();
      await expect(plan).toHaveAttribute('aria-pressed', 'true');
      const d = viewDir(await cameraPose(page));
      expect(Math.abs(d[2]), `view direction when Plan reads pressed: ${d.map((c) => c.toFixed(3)).join(',')}`).toBeGreaterThan(0.999);
    });
  });

  test('P1: Plan lands top-down with the whole scan, R frames all, double-click focuses', async ({ page }, info) => {
    test.setTimeout(90_000);
    const j = startJourney(page, info, 'j3');
    await j.step('open the scan', () => openTerrain(page));
    await j.step('Plan view ends top-down with every point on screen', async () => {
      const plan = page.getByRole('button', { name: 'Plan view' });
      await plan.click();
      await expect(plan).toHaveAttribute('aria-pressed', 'true');
      await waitForCameraSettled(page);
      const d = viewDir(await cameraPose(page));
      expect(Math.abs(d[2]), `settled view direction ${d.map((c) => c.toFixed(3)).join(',')}`).toBeGreaterThan(0.999);
      expect(await offscreen(page)).toBe(0);
      await plan.click();
      await expect(plan).toHaveAttribute('aria-pressed', 'false');
      await waitForCameraSettled(page);
    });
    await j.step('keyboard: zoom in with the wheel, then R returns to the whole scan', async () => {
      const box = (await page.locator('.olv-canvas').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -240);
      await waitForCameraSettled(page);
      expect(await offscreen(page), 'zoomed in, some points leave the screen').toBeGreaterThan(0);
      await page.locator('.olv-canvas').focus();
      await page.keyboard.press('r');
      await waitForCameraSettled(page);
      expect(await offscreen(page)).toBe(0);
    });
    await j.step('double-click focuses the camera on the clicked point', async () => {
      await setProbe(page, true);
      const { px, py } = await steadyProbe(page, 0.4, 0.55);
      await setProbe(page, false);
      const before = await cameraPose(page);
      const box = (await page.locator('.olv-canvas').boundingBox())!;
      await page.mouse.dblclick(box.x + px, box.y + py);
      await waitForCameraSettled(page);
      const after = await cameraPose(page);
      expect(JSON.stringify(after.target), 'the pivot moved').not.toBe(JSON.stringify(before.target));
      // The new pivot is the clicked point: it projects to the clicked pixel
      // (pivot kept in place) or to the view centre (camera recentred).
      const at = await page.evaluate((t) => (window as unknown as { __OLV_TEST_API__: { projectToClient: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null } }).__OLV_TEST_API__.projectToClient({ x: t[0], y: t[1], z: t[2] }), after.target);
      const centre = await framedScanCentre(page);
      const toClick = Math.hypot(at!.x - (box.x + px), at!.y - (box.y + py));
      const toCentre = Math.hypot(at!.x - centre.x, at!.y - centre.y);
      expect(Math.min(toClick, toCentre), `pivot at ${Math.round(at!.x)},${Math.round(at!.y)}`).toBeLessThan(30);
    });
  });

  test('P1: with reduced motion a view change lands without a long glide', async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const j = startJourney(page, info, 'j3');
    await j.step('open the scan', () => openTerrain(page));
    await j.step('Top view settles within 200 ms', async () => {
      await page.getByRole('button', { name: 'Top view', exact: true }).click();
      await page.waitForTimeout(200);
      const early = await cameraPose(page);
      await page.waitForTimeout(1200);
      const late = await cameraPose(page);
      const moved = Math.hypot(...[0, 1, 2].map((a) => late.position[a] - early.position[a]));
      expect(moved, 'camera still moving 200 ms after the click under reduced motion').toBeLessThan(1e-3);
    });
  });
});

/** Two-finger pointer gesture, the same synthesis touchGesture.spec.ts uses. */
async function pinch(page: Page, c: { x: number; y: number }, r0: number, r1: number): Promise<void> {
  await page.evaluate(async ([cx, cy, r0, r1]) => {
    const canvas = document.querySelector('.olv-canvas') as HTMLElement;
    const rect = canvas.getBoundingClientRect();
    const fire = (type: string, id: number, x: number, y: number) => {
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y, isPrimary: id === 1 }));
    };
    void rect;
    fire('pointerdown', 1, cx - r0, cy);
    fire('pointerdown', 2, cx + r0, cy);
    for (let i = 1; i <= 12; i++) {
      const r = r0 + ((r1 - r0) * i) / 12;
      fire('pointermove', 1, cx - r, cy);
      fire('pointermove', 2, cx + r, cy);
      await new Promise((res) => setTimeout(res, 16));
    }
    fire('pointerup', 1, cx - r1, cy);
    fire('pointerup', 2, cx + r1, cy);
  }, [c.x, c.y, r0, r1] as const);
}

test.describe('J3 navigate (touch, P3)', () => {
  test.skip(() => test.info().project.use.hasTouch !== true, 'touch journey runs on webkit-mobile');

  test('P3: pinch keeps the pinched point under the fingers, and Frame all is reachable by touch', async ({ page }, info) => {
    test.setTimeout(120_000);
    const j = startJourney(page, info, 'j3', [
      {
        pattern: /^The object can not be found here\.$/,
        reason:
          'WebKit NotFoundError from setPointerCapture (three OrbitControls) on the synthesized pointer ids; ' +
          'Playwright has no multi-touch input, and a real finger has a registered pointer id.',
      },
    ]);
    await j.step('open the LAZ', async () => {
      await openWith(page, fixtureBytes('multichunk.laz'), 'multichunk.laz');
      await waitForCameraSettled(page);
    });
    await j.step('pinch out about a scan point', async () => {
      const box = (await page.locator('.olv-canvas').boundingBox())!;
      // A scan point near the right third of the canvas.
      const target = await page.evaluate(([bx, by, bw, bh]) => {
        const api = (window as unknown as { __OLV_TEST_API__: {
          layerProjectPoints: (i: number) => Array<{ project: [number, number, number] }>;
          projectToClient: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null;
        } }).__OLV_TEST_API__;
        let best: { i: number; x: number; y: number; d: number } | null = null;
        for (let i = 0; i < 120000; i += 97) {
          const p = api.layerProjectPoints(i)[0]?.project;
          const xy = p ? api.projectToClient({ x: p[0], y: p[1], z: p[2] }) : null;
          if (!xy) continue;
          const d = Math.hypot(xy.x - (bx + bw * 0.65), xy.y - (by + bh * 0.45));
          if (!best || d < best.d) best = { i, x: xy.x, y: xy.y, d };
        }
        return best;
      }, [box.x, box.y, box.width, box.height] as const);
      expect(target).not.toBeNull();
      await pinch(page, target!, 30, 70);
      await waitForCameraSettled(page);
      const after = await page.evaluate((i) => {
        const api = (window as unknown as { __OLV_TEST_API__: {
          layerProjectPoints: (i: number) => Array<{ project: [number, number, number] }>;
          projectToClient: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null;
        } }).__OLV_TEST_API__;
        const p = api.layerProjectPoints(i)[0].project;
        return api.projectToClient({ x: p[0], y: p[1], z: p[2] });
      }, target!.i);
      const slide = Math.hypot(after!.x - target!.x, after!.y - target!.y);
      expect(slide, `the pinched point slid ${slide.toFixed(1)} px`).toBeLessThan(20);
    });
    await j.step('Frame all is a visible touch target', async () => {
      const frame = page.getByRole('button', { name: 'Frame all' }).filter({ visible: true }).first();
      await expect(frame).toBeVisible();
      await frame.tap();
      await waitForCameraSettled(page);
    });
  });
});
