import { test, expect, type Page } from '@playwright/test';
import { dropTinyLas, dropTinyPly, reloadSettled } from './helpers';
import { DEFAULT_FOV } from '../../src/render/renderBootstrapPolicy';
import { MOBILE_LAYOUT_QUERY } from '../../src/ui/isMobileDevice';

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
/**
 * Wait until the opening flight has run, then return the pose it left.
 *
 * A scan attaches with the camera top-down and still, and only then does
 * `openScan` start the tween to the opening view, just before it adds
 * `olv-has-scan` to the body. Waiting for the class puts the start of the
 * flight behind us.
 *
 * The end is counted in frames, not milliseconds. A tween advances once per
 * rendered frame, and on the software-rendered WebKit CI job a frame takes
 * over half a second, so a pose that looked still across 500 ms was only
 * between two frames of a flight still in progress. A pose unchanged across
 * three animation frames is a camera the loop has stopped moving.
 *
 * The page is brought forward first because the app stops its frame loop
 * while the document is hidden, which would stop the flight with it.
 */
async function settledPose(page: Page): Promise<string> {
  await expect(page.locator('body.olv-has-scan')).toHaveCount(1, { timeout: 30_000 });
  await page.bringToFront();
  await expect
    .poll(() => page.evaluate(() => document.visibilityState), { timeout: 10_000 })
    .toBe('visible');
  const threeFrames = () => page.evaluate(() => new Promise<void>((resolve) => {
    let n = 0;
    const tick = (): void => { n += 1; if (n >= 3) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  let last = await readPose(page);
  for (let i = 0; i < 120; i++) {
    await threeFrames();
    const next = await readPose(page);
    if (next === last) return next;
    last = next;
  }
  throw new Error('the camera was still moving after 120 three-frame checks');
}

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
    await settledPose(page);

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
    await settledPose(page);

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
    await settledPose(page);

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

    await reloadSettled(page);
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await openRenderingSection(page);

    const chipAfter = page.locator('.olv-chip', { hasText: 'Touch twist' });
    await expect(chipAfter).not.toHaveClass(/olv-chip-active/);
  });
});

/**
 * Screen-space motion checks on a Z-up survey. The pose oracle gives the
 * camera position and orbit pivot; with the survey's Z up and the default
 * field of view, a world point projects to canvas pixels the same way the
 * viewer draws it. Directions are what these tests read, so a small error in
 * the field of view would not change a sign.
 */
type Pose = { position: number[]; target: number[] };
type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

function basis(p: Pose): { eye: V3; fwd: V3; right: V3; up: V3 } {
  const eye = p.position as V3;
  const fwd = unit(sub(p.target as V3, eye));
  const right = unit(cross(fwd, [0, 0, 1]));
  return { eye, fwd, right, up: cross(right, fwd) };
}

function project(p: Pose, w: number, h: number, q: V3): { x: number; y: number } {
  const { eye, fwd, right, up } = basis(p);
  const t = Math.tan((DEFAULT_FOV * Math.PI) / 360);
  const d = sub(q, eye);
  const z = dot(d, fwd);
  return { x: w / 2 + (dot(d, right) / (z * t * (w / h))) * (w / 2), y: h / 2 - (dot(d, up) / (z * t)) * (h / 2) };
}

/** The point at the pivot's height under canvas pixel (x, y). */
function groundUnder(p: Pose, w: number, h: number, x: number, y: number): V3 {
  const { eye, fwd, right, up } = basis(p);
  const t = Math.tan((DEFAULT_FOV * Math.PI) / 360);
  const nx = ((x / w) * 2 - 1) * t * (w / h);
  const ny = (1 - (y / h) * 2) * t;
  const dir: V3 = [fwd[0] + right[0] * nx + up[0] * ny, fwd[1] + right[1] * nx + up[1] * ny, fwd[2] + right[2] * nx + up[2] * ny];
  const k = (p.target[2] - eye[2]) / dir[2];
  return [eye[0] + dir[0] * k, eye[1] + dir[1] * k, eye[2] + dir[2] * k];
}

/**
 * A one-finger drag. It reuses pointer id 1, which the browser always knows
 * (the mouse), so OrbitControls' pointer capture accepts a synthetic event.
 */
async function oneFingerDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> {
  await page.evaluate(
    async ([from, to, steps]) => {
      const canvas = document.querySelector('.olv-canvas') as HTMLElement;
      const rect = canvas.getBoundingClientRect();
      const fire = (type: string, x: number, y: number) => {
        const ev = new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true,
          clientX: rect.left + x, clientY: rect.top + y, buttons: type === 'pointerup' ? 0 : 1,
        });
        Object.defineProperty(ev, 'offsetX', { get: () => x });
        Object.defineProperty(ev, 'offsetY', { get: () => y });
        canvas.dispatchEvent(ev);
      };
      fire('pointerdown', from.x, from.y);
      for (let i = 1; i <= steps; i++) {
        fire('pointermove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
        await new Promise((r) => requestAnimationFrame(r));
      }
      fire('pointerup', to.x, to.y);
    },
    [from, to, steps] as const,
  );
}

test.describe('touch moves the scene the way the fingers move (Z-up survey)', () => {
  test('a one-finger drag up carries the ground under the finger up', async ({ page, browserName }) => {
    // Desktop Firefox does not start OrbitControls' drag from a synthetic touch
    // pointer. The mouse and finger share one orbit path, which
    // tests/orbitScreenDirection.test.ts drives with both.
    test.skip(browserName === 'firefox', 'synthetic touch pointer does not reach OrbitControls on desktop Firefox');
    await page.goto('/?test=1');
    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    const before = JSON.parse(await settledPose(page)) as Pose;
    const box = await page.locator('.olv-canvas').boundingBox();
    if (!box) throw new Error('no canvas bounding box');
    const { width: w, height: h } = box;
    const start = { x: w / 2, y: h * 0.7 };
    const grabbed = groundUnder(before, w, h, start.x, start.y);
    await oneFingerDrag(page, start, { x: start.x, y: start.y - 60 });
    const after = JSON.parse(await settledPose(page)) as Pose;
    const a = project(before, w, h, grabbed);
    const b = project(after, w, h, grabbed);
    // Up on screen, and not sideways.
    expect(b.y - a.y).toBeLessThan(-2);
    expect(Math.abs(b.x - a.x)).toBeLessThan(0.2 * Math.abs(b.y - a.y));
  });

  test('a pinch zooms toward the fingers, not the screen centre', async ({ page }) => {
    await page.goto('/?test=1');
    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    const before = JSON.parse(await settledPose(page)) as Pose;
    const box = await page.locator('.olv-canvas').boundingBox();
    if (!box) throw new Error('no canvas bounding box');
    const cx = box.width * 0.75;
    const cy = box.height / 2;
    const r0 = Math.min(40, box.width * 0.08);
    const r1 = r0 * 2;
    await twoFingerGesture(page, { x: cx - r0, y: cy }, { x: cx + r0, y: cy }, { x: cx - r1, y: cy }, { x: cx + r1, y: cy });
    const after = JSON.parse(await settledPose(page)) as Pose;
    const dist = (p: Pose) => Math.hypot(...sub(p.position as V3, p.target as V3));
    expect(dist(after)).toBeLessThan(dist(before));
    // The pivot moved toward the right half, where the fingers are.
    const shift = dot(sub(after.target as V3, before.target as V3), basis(before).right);
    expect(shift).toBeGreaterThan(0);
  });
});

async function openRenderingSection(page: import('@playwright/test').Page): Promise<void> {
  const renderingDetails = page.locator('details.olv-section-collapsible', {
    has: page.locator('summary', { hasText: 'Rendering' }),
  });

  // At phone width the panels live in a collapsed bottom sheet rather than an
  // always-open side rail, so the summary exists in the DOM but has no layout
  // box. The sheet opens and its View tab holds the Rendering section.
  //
  // Pick the branch from the layout query the app itself keys on, not from a
  // one-shot visibility probe. The summary on desktop can be off-layout for a
  // frame after the empty state hides, and a non-waiting `isVisible()` there
  // sent desktop WebKit down the phone path to click a sheet handle that never
  // renders. The sheet in turn is shown only once the scan is revealed, which
  // can also trail the empty state, so on a phone wait for the sheet before
  // touching it.
  const isPhoneLayout = await page.evaluate(
    (q) => window.matchMedia(q).matches,
    MOBILE_LAYOUT_QUERY,
  );
  if (isPhoneLayout) {
    await expect(page.locator('.olv-mobile-sheet')).toBeVisible();
    const viewTab = page.locator('.olv-msheet-tab', { hasText: 'View' });
    // The sheet starts at 'peek' (head only), where the tabs are already
    // showing; selecting a tab opens the body.
    await viewTab.click();
    await expect(viewTab).toHaveAttribute('aria-selected', 'true');
  }
  await expect(renderingDetails.locator('summary')).toBeVisible({ timeout: 10_000 });

  const isOpen = await renderingDetails.evaluate((d) =>
    (d as HTMLDetailsElement).open,
  );
  if (!isOpen) await renderingDetails.locator('summary').click();
}
