import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { openToolPage } from './helpers';
import { dropBytes, geomFixtures, towerLas, towerPoints } from './geomFixtures';

/**
 * The clip box must change what is drawn, not only what the panel says. These
 * specs read the drawn pixels back: Inside and Outside, a bounds edit, Fit to
 * scan, Clear, a placed layer, a Box drawn on the ground (3D volume, not a
 * slab), picking that skips clipped-away points, and an orbit frame-time guard.
 *
 * Coordinates are the scan's local frame (origin floor(min)), so the ground
 * sits near local height 1. Set OLV_CLIP_SHOTS=<dir> to write screenshots.
 */
const SHOTS = process.env.OLV_CLIP_SHOTS;
const GZ = 1; // ground height, local frame
const TOP = 9; // tower roof height, local frame

interface Api {
  setMeasureMode: (on: boolean) => void;
  setMeasureKind: (k: string) => void;
  placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
  getMeasurementCount: () => number;
  getClipState: () => { clip: { box: { min: number[]; max: number[] }; mode: string; enabled: boolean } | null; count: { kept: number; total: number } | null };
  getCameraPose: () => { position: number[]; target: number[] };
  applyCameraPose: (pose: { position: number[]; target: number[] }) => void;
  projectToClient: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null;
  pickAtClient: (x: number, y: number) => boolean;
  layerProjectPoints: (i: number) => Array<{ id: string; project: [number, number, number] }>;
}
const api = <T>(page: Page, fn: (a: Api) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__OLV_TEST_API__)`) as Promise<T>;

async function openTower(page: Page, size = { width: 1100, height: 700 }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/?test=1');
  await dropBytes(page, await towerLas(), 'tower.las');
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await page.waitForFunction(() => !!(window as unknown as { __OLV_TEST_API__?: unknown }).__OLV_TEST_API__);
  await page.waitForFunction(() => document.querySelector('.olv-canvas') !== null);
  await page.waitForTimeout(2500);
}

/** A PNG of the canvas alone, so a pixel read is the scene and nothing painted over it. */
async function canvasShot(page: Page, path?: string): Promise<Buffer> {
  const canvas = page.locator('canvas.olv-canvas');
  await page.evaluate(() => {
    document.body.style.visibility = 'hidden';
    (document.querySelector('canvas.olv-canvas') as HTMLElement).style.visibility = 'visible';
  });
  try {
    return await canvas.screenshot(path ? { path } : {});
  } finally {
    await page.evaluate(() => {
      document.body.style.visibility = '';
      (document.querySelector('canvas.olv-canvas') as HTMLElement).style.visibility = '';
    });
  }
}

/** Pixels differing from the background within `r` px of each scene point. */
async function lit(page: Page, pts: Array<[number, number, number]>, r = 7): Promise<number[]> {
  const shot = await canvasShot(page);
  const rect = (await page.locator('canvas.olv-canvas').boundingBox())!;
  const screen = await page.evaluate(
    (ps) => ps.map((p) => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.projectToClient({ x: p[0], y: p[1], z: p[2] })),
    pts,
  );
  return page.evaluate(
    async ({ b64, screen, rect, r }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      const bg = [d[0], d[1], d[2]];
      return screen.map((s) => {
        if (!s) return -1;
        const cx = Math.round(s.x - rect.x);
        const cy = Math.round(s.y - rect.y);
        let n = 0;
        for (let y = Math.max(0, cy - r); y <= Math.min(bmp.height - 1, cy + r); y++) {
          for (let x = Math.max(0, cx - r); x <= Math.min(bmp.width - 1, cx + r); x++) {
            const o = (y * bmp.width + x) * 4;
            if (Math.abs(d[o] - bg[0]) + Math.abs(d[o + 1] - bg[1]) + Math.abs(d[o + 2] - bg[2]) > 30) n++;
          }
        }
        return n;
      });
    },
    { b64: shot.toString('base64'), screen, rect: { x: rect.x, y: rect.y }, r },
  );
}

/**
 * The drawn counts at `pts` once `ok` holds. A clip change recompiles the point
 * shader, which takes seconds on a software renderer, so the frame that shows
 * it arrives late; poll for it instead of sleeping a guessed time.
 */
async function drawn(page: Page, pts: Array<[number, number, number]>, ok: (n: number[]) => boolean, what: string): Promise<number[]> {
  let last: number[] = [];
  await expect.poll(async () => { last = await lit(page, pts); return ok(last); }, { message: what, timeout: 30_000, intervals: [400] }).toBe(true);
  return last;
}
const allLit = (n: number[]): boolean => n.every((v) => v > 8);
const noneLit = (n: number[]): boolean => n.every((v) => v === 0);

/** Pixels differing from the background anywhere on the canvas. */
async function litTotal(page: Page): Promise<number> {
  const shot = await canvasShot(page);
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let n = 0;
    for (let o = 0; o < d.length; o += 4) {
      if (Math.abs(d[o] - d[0]) + Math.abs(d[o + 1] - d[1]) + Math.abs(d[o + 2] - d[2]) > 30) n++;
    }
    return n;
  }, shot.toString('base64'));
}

async function snap(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await canvasShot(page, `${SHOTS}/${name}.png`);
}

/**
 * Isolating a box glides the camera to the kept volume (asserted in the first
 * test). The pixel probes below are fixed scene points, so the tests that use
 * them put the camera back where it was and wait for the glide to land.
 */
async function backToView(page: Page, pose: { position: number[]; target: number[] }): Promise<void> {
  await page.evaluate((p) => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.applyCameraPose(p), pose);
  await expect.poll(async () => {
    const q = (await api(page, (a) => a.getCameraPose())).position;
    return Math.hypot(q[0] - pose.position[0], q[1] - pose.position[1], q[2] - pose.position[2]);
  }, { message: 'the camera returns to the original view', timeout: 30_000 }).toBeLessThan(0.05);
}

/** Two picks on the ground, a few centimetres apart in height, as a user's clicks give. */
async function drawGroundBox(page: Page): Promise<void> {
  await api(page, (a) => {
    a.setMeasureMode(true);
    a.setMeasureKind('box');
    a.placeMeasurementPoint({ x: 11.9, y: 7.9, z: 1.012 });
    a.placeMeasurementPoint({ x: 22.9, y: 17.9, z: 0.989 });
    if (a.getMeasurementCount() < 1) throw new Error('box not committed');
  });
}

/** Points of the tower scan inside x 11.9..22.9, y 7.9..17.9, at any height. */
function expectedInsideColumn(): { inside: number; total: number } {
  const p = towerPoints();
  let inside = 0;
  for (let i = 0; i < p.count; i++) if (p.x[i] >= 11.9 && p.x[i] <= 22.9 && p.y[i] >= 7.9 && p.y[i] <= 17.9) inside++;
  return { inside, total: p.count };
}

const ROOF: [number, number, number] = [17.5, 12.5, TOP];
const WALL: [number, number, number] = [17, 15, 5];
const GROUND_IN_BOX: [number, number, number] = [13, 16.5, GZ];
const GROUND_FAR: [number, number, number] = [35, 25, GZ];
const GROUND_FAR2: [number, number, number] = [4, 4, GZ];

test('a box drawn on the ground isolates a 3D volume, not a slab, and the points outside are gone', async ({ page }) => {
  test.setTimeout(150_000);
  await openTower(page);
  const before = await lit(page, [ROOF, WALL, GROUND_IN_BOX, GROUND_FAR, GROUND_FAR2]);
  for (const n of before) expect(n, `baseline pixels ${before}`).toBeGreaterThan(8);
  const totalBefore = await litTotal(page);
  const pose0 = await api(page, (a) => a.getCameraPose());
  await snap(page, '1-before');

  await openToolPage(page, 'Measure');
  await drawGroundBox(page);
  await page.locator('.olv-mp-use-clip').click();
  await expect(page.locator('.olv-clip-indicator')).toBeVisible();

  const s = await api(page, (a) => a.getClipState());
  const want = expectedInsideColumn();
  // The height is the scan's, not the 2.3 cm the two picks span.
  expect(s.clip!.enabled).toBe(true);
  expect(s.clip!.box.min[2]).toBeLessThanOrEqual(0.95);
  expect(s.clip!.box.max[2]).toBeGreaterThanOrEqual(TOP);
  // Kept is the whole column: ground in the footprint AND the tower above it.
  expect(s.count).toEqual({ kept: want.inside, total: want.total });
  expect(want.inside).toBeGreaterThan(5000);
  expect(want.inside).toBeLessThan(want.total / 2);

  // The orbit pivot moves into the kept volume (it was the old scan centre).
  const c = s.clip!.box;
  const mid = [(c.min[0] + c.max[0]) / 2, (c.min[1] + c.max[1]) / 2, (0.98 + 9) / 2]; // z: the data, not the margin
  await expect.poll(async () => {
    const t = (await api(page, (a) => a.getCameraPose())).target;
    return Math.hypot(t[0] - mid[0], t[1] - mid[1], t[2] - mid[2]);
  }, { message: 'the camera frames the clipped volume', timeout: 20_000 }).toBeLessThan(0.5);
  await backToView(page, pose0);

  const after = await drawn(page, [ROOF, WALL, GROUND_IN_BOX, GROUND_FAR, GROUND_FAR2],
    (n) => n[3] === 0 && n[4] === 0 && n[0] > 8 && n[1] > 8 && n[2] > 8, 'the volume stays, the far ground is clipped away');
  await snap(page, '2-isolated-3d');
  // Inside the volume: the tower (roof and wall) and the ground under it still draw.
  expect(after[0], `roof ${after}`).toBeGreaterThan(8);
  expect(after[1], `wall ${after}`).toBeGreaterThan(8);
  expect(after[2], `ground in box ${after}`).toBeGreaterThan(8);
  // Outside it: nothing.
  expect(after[3], `far ground ${after}`).toBe(0);
  expect(after[4], `far ground 2 ${after}`).toBe(0);
  // The view is a volume, not a thin slice: plenty of pixels, spread over height.
  expect(await litTotal(page)).toBeGreaterThan(totalBefore * 0.03);
});

test('Outside mode removes the volume; Fit to scan, a numeric edit and Clear all change the drawing', async ({ page }) => {
  test.setTimeout(180_000);
  await openTower(page);
  const pose0 = await api(page, (a) => a.getCameraPose());
  await openToolPage(page, 'Measure');
  await drawGroundBox(page);
  await page.locator('.olv-mp-use-clip').click();
  await expect(page.locator('.olv-clip-indicator')).toBeVisible();
  await backToView(page, pose0);
  const clip = page.locator('.olv-clip-panel');
  const probe: Array<[number, number, number]> = [ROOF, WALL, GROUND_IN_BOX, GROUND_FAR];
  const want = expectedInsideColumn();

  // Inside first: the volume draws and the far ground does not (the GPU honours the clip).
  await drawn(page, probe, (n) => n[0] > 8 && n[1] > 8 && n[2] > 8 && n[3] === 0, 'Inside keeps only the volume');

  // Outside: the column is removed, everything else stays.
  await clip.locator('.olv-bc-pill', { hasText: 'Outside' }).click();
  const out = await drawn(page, probe, (n) => noneLit(n.slice(0, 3)) && n[3] > 8, 'the column is removed, the rest stays');
  await snap(page, '3-outside');
  expect(out[3]).toBeGreaterThan(8);
  const st = await api(page, (a) => a.getClipState());
  expect(st.count).toEqual({ kept: want.total - want.inside, total: want.total });

  // Back to Inside, then a numeric edit: pull the x maximum to the tower's west side.
  await clip.locator('.olv-bc-pill', { hasText: 'Inside' }).click();
  await clip.locator('summary', { hasText: 'Advanced' }).click();
  const xMax = clip.locator('input.olv-clip-num').nth(1);
  await xMax.fill('16');
  // The roof at x 17.5 is now outside the box; the ground at x 13 is still inside.
  const edit = await drawn(page, probe, (n) => n[0] === 0 && n[2] > 8, 'an Advanced edit moves the clip');
  await snap(page, '4-edited-xmax');
  expect(edit[3], `edit ${edit}`).toBe(0);

  // Fit to scan: the box is the whole scan again, so everything draws.
  await clip.getByRole('button', { name: 'Fit to scan' }).click();
  await drawn(page, probe, allLit, 'Fit to scan draws everything again');

  // Clear: off, everything draws, the readout is gone.
  await clip.getByRole('button', { name: 'Clear' }).click();
  await drawn(page, probe, allLit, 'Clear draws everything');
  expect((await api(page, (a) => a.getClipState())).clip?.enabled === true).toBe(false);
});

test('Draw clipping box and the Box row action build the same clip', async ({ page }) => {
  test.setTimeout(120_000);
  await openTower(page);
  await openToolPage(page, 'Clip box');
  await page.locator('.olv-clip-draw').click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
  await drawGroundBox(page);
  await page.getByRole('button', { name: /Isolate this box/ }).click();
  await expect(page.locator('.olv-clip-indicator')).toBeVisible();
  const viaCard = (await api(page, (a) => a.getClipState())).clip!;

  await page.locator('.olv-clip-indicator').getByRole('button', { name: 'Clear clipping' }).click();
  await openToolPage(page, 'Measure');
  await page.locator('.olv-mp-use-clip').click();
  await expect(page.locator('.olv-clip-indicator')).toBeVisible();
  const viaRow = (await api(page, (a) => a.getClipState())).clip!;

  expect(viaRow).toEqual(viaCard);
  expect(viaRow.mode).toBe('keep-inside');
  // The measurement was left as drawn: still a 2.3 cm tall box.
  await openToolPage(page, 'Measure');
  await expect(page.locator('.olv-mp-row')).toHaveCount(1);
});

test('a clipped-away point cannot be picked, and double-click focus lands on what is drawn', async ({ page }) => {
  test.setTimeout(150_000);
  await openTower(page);
  let farScreen = (await api(page, (a) => a.projectToClient({ x: 35, y: 25, z: 1 })))!;
  let wallScreen = (await api(page, (a) => a.projectToClient({ x: 17, y: 15, z: 5 })))!;
  // Unclipped, the ground there is pickable (this is what the hidden point used to answer).
  expect(await api(page, (a) => a.pickAtClient(0, 0))).toBe(false);
  expect(await page.evaluate(([x, y]) => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.pickAtClient(x, y), [farScreen.x, farScreen.y])).toBe(true);

  const pose0 = await api(page, (a) => a.getCameraPose());
  await openToolPage(page, 'Measure');
  await drawGroundBox(page);
  await page.locator('.olv-mp-use-clip').click();
  await expect(page.locator('.olv-clip-indicator')).toBeVisible();
  await api(page, (a) => a.setMeasureMode(false));
  await backToView(page, pose0);
  farScreen = (await api(page, (a) => a.projectToClient({ x: 35, y: 25, z: 1 })))!;
  wallScreen = (await api(page, (a) => a.projectToClient({ x: 17, y: 15, z: 5 })))!;

  // Clipped: the far ground is gone from the screen and from the pick.
  expect(await page.evaluate(([x, y]) => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.pickAtClient(x, y), [farScreen.x, farScreen.y])).toBe(false);
  expect(await page.evaluate(([x, y]) => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.pickAtClient(x, y), [wallScreen.x, wallScreen.y])).toBe(true);

  // Double-click on the clipped-away area: nothing to focus on, the pivot stays put.
  const t0 = (await api(page, (a) => a.getCameraPose())).target;
  await page.mouse.dblclick(farScreen.x, farScreen.y);
  await page.waitForTimeout(1500);
  const t1 = (await api(page, (a) => a.getCameraPose())).target;
  expect(Math.hypot(t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2])).toBeLessThan(0.05);

  // Double-click on the tower: the pivot glides to a point of the kept volume (the
  // pick takes the point nearest the ray, which may lie behind the wall), never
  // to one outside the box.
  const box = (await api(page, (a) => a.getClipState())).clip!.box;
  await page.mouse.dblclick(wallScreen.x, wallScreen.y);
  await expect.poll(async () => {
    const t = (await api(page, (a) => a.getCameraPose())).target;
    return Math.hypot(t[0] - t0[0], t[1] - t0[1], t[2] - t0[2]);
  }, { timeout: 20_000 }).toBeGreaterThan(0.5);
  await page.waitForTimeout(2500);
  const t2 = (await api(page, (a) => a.getCameraPose())).target;
  for (let i = 0; i < 3; i++) {
    expect(t2[i], `pivot axis ${i} inside the clip box`).toBeGreaterThanOrEqual(box.min[i] - 0.05);
    expect(t2[i], `pivot axis ${i} inside the clip box`).toBeLessThanOrEqual(box.max[i] + 0.05);
  }
});

/**
 * Frame-time guard. Measured as requestAnimationFrame deltas in the page while
 * a scripted mouse drag orbits the camera, with the clip off and then on, at the
 * framed distance and again after dollying in on the tower. Every pair is
 * measured in the same page, OFF then ON then OFF then ON, and the ratio uses
 * the faster OFF and the slower ON so a noisy runner cannot flatter it. The
 * ratio bound is generous (2.5x); the absolute bound is for a software
 * renderer, which draws a frame in a few hundred milliseconds.
 */
async function orbitFrames(page: Page, steps = 6): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __fr: number[]; __stop: boolean };
    w.__fr = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (t: number): void => { w.__fr.push(t - last); last = t; if (!w.__stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const box = (await page.locator('canvas.olv-canvas').boundingBox())!;
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.6;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < steps; i++) await page.mouse.move(cx + Math.sin(i / 3) * 160, cy + Math.cos(i / 3) * 50);
  await page.mouse.up();
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const w = window as unknown as { __fr: number[]; __stop: boolean };
    w.__stop = true;
    return w.__fr.slice(1);
  });
}
const median = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0;

test('orbiting near the clipped area is not materially slower than without a clip', async ({ page }) => {
  test.setTimeout(300_000);
  await openTower(page, { width: 800, height: 520 });
  await openToolPage(page, 'Measure');
  await drawGroundBox(page);
  // Isolate and clear once so the clip exists, then switch it with the panel.
  await page.locator('.olv-mp-use-clip').click();
  await expect(page.locator('.olv-clip-indicator')).toBeVisible();
  await api(page, (a) => a.setMeasureMode(false));
  const chip = page.locator('.olv-clip-indicator');
  const setClip = async (on: boolean): Promise<void> => {
    const enabled = (await api(page, (a) => a.getClipState())).clip?.enabled === true;
    if (enabled === on) return;
    if (on) await page.locator('.olv-clip-panel .olv-clip-enable input').check();
    else await chip.getByRole('button', { name: 'Clear clipping' }).click();
    await page.waitForTimeout(600);
  };
  const phase = async (label: string): Promise<{ off: number[]; on: number[] }> => {
    const offA = median(await (async () => { await setClip(false); return orbitFrames(page); })());
    const onA = median(await (async () => { await setClip(true); return orbitFrames(page); })());
    const offB = median(await (async () => { await setClip(false); return orbitFrames(page); })());
    const onB = median(await (async () => { await setClip(true); return orbitFrames(page); })());
    console.log(`[clip frame time] ${label}: off ${offA.toFixed(0)}/${offB.toFixed(0)} ms, on ${onA.toFixed(0)}/${onB.toFixed(0)} ms`);
    return { off: [offA, offB], on: [onA, onB] };
  };

  const far = await phase('far');
  // Dolly in on the tower, inside the clipped area.
  const box = (await page.locator('canvas.olv-canvas').boundingBox())!;
  const wall = (await api(page, (a) => a.projectToClient({ x: 17, y: 15, z: 5 })))!;
  await page.mouse.move(wall.x, wall.y);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(150); }
  await page.waitForTimeout(800);
  expect(box.width).toBeGreaterThan(0);
  const near = await phase('near');

  for (const p of [far, near]) {
    const ratio = Math.max(...p.on) / Math.min(...p.off);
    expect(ratio, `on/off ${JSON.stringify(p)}`).toBeLessThan(2.5);
    expect(Math.max(...p.on), 'absolute median frame, ms').toBeLessThan(1500);
  }
});

test('a clip over a placed layer draws where that layer is (Inside keeps it, Outside removes it)', async ({ page }) => {
  test.setTimeout(240_000);
  const fx = await geomFixtures();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto('/?test=1');
  await dropBytes(page, fx.geomA, 'geom-a.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 30_000 });
  await dropBytes(page, fx.geomB, 'geom-b.las');
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 30_000 });
  await page.waitForFunction(() => !!(window as unknown as { __OLV_TEST_API__?: unknown }).__OLV_TEST_API__);
  await page.waitForTimeout(3000);
  // Index 0 of each layer, in the project frame the clip box and the drawing share.
  const [pA, pB] = (await api(page, (a) => a.layerProjectPoints(0))).map((l) => l.project);
  expect(Math.abs(pB[0] - pA[0]), 'layer B sits away from layer A').toBeGreaterThan(50);
  const probe: Array<[number, number, number]> = [pA, pB];
  // A view that holds both layers (the camera stays on the first when the second is added).
  await backToView(page, { position: [(pA[0] + pB[0]) / 2, -70, 100], target: [(pA[0] + pB[0]) / 2, 5, 0] });
  const base = await drawn(page, probe, (n) => n[0] > 4 && n[1] > 4, 'both layers draw before any clip');
  expect(base.length).toBe(2);

  // A box around layer B only, as the Clip page's Advanced fields would hold it.
  await openToolPage(page, 'Clip box');
  const panel = page.locator('.olv-clip-panel');
  await panel.locator('label', { hasText: 'Clip the scan to this box' }).click();
  await panel.locator('summary', { hasText: 'Advanced' }).click();
  const set = async (label: string, v: number): Promise<void> => {
    const input = panel.getByLabel(label, { exact: true });
    await input.fill(String(v));
    await input.press('Enter');
  };
  await set('X max', pB[0] + 8); await set('X min', pB[0] - 2);
  await set('Y max', pB[1] + 8); await set('Y min', pB[1] - 2);
  await set('Z max', 1e5); await set('Z min', -1e5);
  await drawn(page, probe, (n) => n[0] === 0 && n[1] > 4, 'Inside keeps layer B and clips layer A');
  await panel.locator('.olv-bc-pill', { hasText: 'Outside' }).click();
  await drawn(page, probe, (n) => n[0] > 4 && n[1] === 0, 'Outside keeps layer A and clips layer B');
});
