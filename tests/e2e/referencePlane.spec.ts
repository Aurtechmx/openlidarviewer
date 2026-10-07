import { test, expect, type Page, type Locator } from '@playwright/test';
import { activate, dropHillsPly, pinNavigationPanel, waitForCameraSettled } from './helpers';
import { isBenignPageError } from './pageErrors';

/**
 * The reference plane in the View panel: on, readout, placed at the scan
 * minimum, carried through orthographic and Plan view, re-placed through three
 * picked points, and off with its GPU resources released.
 *
 * The scan is the hills PLY, a Y-up mesh format with no CRS, so this also
 * covers the Y-up axis naming and the "units" label for an unresolved unit.
 * The section body exposes `data-drawn` and `data-gpu-resources` (geometries
 * plus materials allocated), which is what "released" is asserted against.
 */

async function openSection(page: Page): Promise<Locator> {
  const section = page.locator('details.olv-section-collapsible', {
    has: page.locator('summary', { hasText: 'Reference plane' }),
  });
  if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open))) await section.locator('summary').click();
  return section;
}

test('reference plane: toggle, readout, projections, three-point plane, release', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (!isBenignPageError(e.message)) errors.push(e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !isBenignPageError(m.text())) errors.push(m.text()); });

  await pinNavigationPanel(page);
  await page.goto('/?test=1');
  await dropHillsPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await waitForCameraSettled(page);

  // B twice before the plane's chunk has loaded (the section is still closed)
  // ends where the presses say: off, once the chunk has landed.
  const pending = page.locator('.olv-refplane-toggle');
  await page.keyboard.press('b');
  await page.keyboard.press('b');
  await expect(page.locator('.olv-refplane-honesty')).toHaveCount(1, { timeout: 10_000 }); // the chunk loaded
  await page.waitForTimeout(300);
  await expect(pending).toHaveAttribute('aria-pressed', 'false');

  const section = await openSection(page);
  const toggle = section.locator('.olv-refplane-toggle');
  const body = section.locator('.olv-refplane-body');
  const readout = body.locator('.olv-refplane-readout');

  // Off by default, with one static label; pressed state is aria-pressed.
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('Reference plane');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveText('Reference plane');
  await expect(body.locator('.olv-refplane-honesty')).toHaveText('Reference plane, not measured terrain.');
  await expect(readout).toContainText('Elevation: not set');
  await expect(body).toHaveAttribute('data-drawn', 'false');

  // Scan minimum: drawn, labelled as not ground, Y-up axis names, source units.
  await body.getByRole('button', { name: 'Use scan minimum' }).click();
  await expect(body).toHaveAttribute('data-drawn', 'true');
  await expect(readout).toContainText('lowest point in the scan, not ground');
  await expect(readout).toContainText('Orientation: Horizontal');
  await expect(readout).toContainText(/Origin: X 0\.000 units, Z 0\.000 units/);
  await expect(readout).toContainText(/Grid [\d.]+ units, minor/);
  await expect(body).not.toHaveAttribute('data-gpu-resources', '0');

  // Orthographic, then Plan view: still drawn, spacing readout still live.
  const views = page.locator('.olv-cam-views');
  await views.locator('.olv-ortho-toggle').click();
  await expect(views.locator('.olv-ortho-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(body).toHaveAttribute('data-drawn', 'true');
  await expect(readout).toContainText(/Grid [\d.]+ units/);
  await views.locator('.olv-ortho-toggle').click();
  await views.locator('.olv-plan-toggle').click();
  await expect(views.locator('.olv-plan-toggle')).toHaveAttribute('aria-pressed', 'true');
  await waitForCameraSettled(page);
  await expect(body).toHaveAttribute('data-drawn', 'true');
  await expect(readout).toContainText(/Grid [\d.]+ units/);

  // Three points picked on the scan in Plan view, where the scan lies flat
  // under the centre of the canvas whatever the renderer's framing.
  await body.getByRole('button', { name: 'Pick 3 points' }).click();
  const status = body.locator('.olv-refplane-status');
  await expect(status).toContainText('Click the first point');
  const box = (await page.locator('.olv-canvas').boundingBox())!;
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const prompts = ['Click the second point', 'Click the third point', 'passes through them exactly'];
  // Spots where the canvas itself is under the pointer, not a card or panel.
  const onCanvas = await page.evaluate(({ x, y }) => {
    const out: Array<[number, number]> = [];
    for (let dy = -240; dy <= 240; dy += 15) for (let dx = -320; dx <= 320; dx += 15) {
      if (document.elementFromPoint(x + dx, y + dy)?.tagName === 'CANVAS') out.push([dx, dy]);
    }
    return out;
  }, c);
  // A miss reports "No scan point" and keeps the pick open, so try the canvas
  // spots nearest each wanted offset until one lands on the scan.
  const wants: Array<[number, number]> = [[-60, -45], [60, -45], [0, 50]];
  for (const [i, want] of wants.entries()) {
    const order = [...onCanvas].sort((p, q) => Math.hypot(p[0] - want[0], p[1] - want[1]) - Math.hypot(q[0] - want[0], q[1] - want[1]));
    let landed = false;
    let last = '';
    for (const [dx, dy] of order.slice(0, 40)) {
      await page.mouse.click(c.x + dx, c.y + dy);
      last = (await status.textContent()) ?? '';
      if (last.includes(prompts[i])) { landed = true; break; }
    }
    expect(landed, `pick ${i + 1} found a scan point (last status: "${last}")`).toBe(true);
  }
  await expect(readout).toContainText(/Orientation: Through 3 picked points, dip [\d.]+°/);
  await expect(body.locator('select').first()).toHaveValue('three-point');
  await expect(body).toHaveAttribute('data-drawn', 'true');
  await views.locator('.olv-plan-toggle').click();
  await expect(views.locator('.olv-plan-toggle')).toHaveAttribute('aria-pressed', 'false');

  // Off: nothing drawn, every geometry and material released.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(body).toHaveAttribute('data-drawn', 'false');
  await expect(body).toHaveAttribute('data-gpu-resources', '0');

  // The key binding turns it back on with the same settings.
  await page.keyboard.press('b');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(body).toHaveAttribute('data-drawn', 'true');

  expect(errors).toEqual([]);
});

/** Pixels in the canvas screenshot that differ from its corner (background) colour. */
async function litPixels(page: Page): Promise<number> {
  const png = (await page.locator('.olv-canvas').screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const [r0, g0, b0] = [d[0], d[1], d[2]];
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 12) lit++;
    }
    return lit;
  }, png);
}

async function placePlane(page: Page): Promise<Locator> {
  const section = await openSection(page);
  await section.locator('.olv-refplane-toggle').click();
  await section.getByRole('button', { name: 'Use scan minimum' }).click();
  const body = section.locator('.olv-refplane-body');
  await expect(body).toHaveAttribute('data-drawn', 'true');
  return body;
}

/** Capture the canvas into the page under `key`; pixels stay in the page. */
async function capture(page: Page, key: string): Promise<void> {
  const png = (await page.locator('.olv-canvas').screenshot()).toString('base64');
  await page.evaluate(async ({ b64, key }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    (window as unknown as Record<string, Uint8ClampedArray>)[key] = ctx.getImageData(0, 0, c.width, c.height).data;
  }, { b64: png, key });
}

/** Pixels that differ between two captures. */
function changed(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(({ a, b }) => {
    const w = window as unknown as Record<string, Uint8ClampedArray>;
    const x = w[a];
    const y = w[b];
    let n = 0;
    for (let i = 0; i < Math.min(x.length, y.length); i += 4) {
      if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 6) n++;
    }
    return n;
  }, { a, b });
}

test('reference plane: redrawn after a WebGL context loss and restore', async ({ page }) => {
  await page.goto('/?test=1');
  await dropHillsPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await waitForCameraSettled(page);
  const canvas = page.locator('.olv-canvas');
  const hasWebgl = await canvas.evaluate((c) => !!(c as HTMLCanvasElement).getContext('webgl2')?.getExtension('WEBGL_lose_context'));
  test.skip(!hasWebgl, 'viewer is not on a WebGL 2 context with WEBGL_lose_context');

  const body = await placePlane(page);
  const section = page.locator('details.olv-section-collapsible', { has: page.locator('summary', { hasText: 'Reference plane' }) });
  const toggle = section.locator('.olv-refplane-toggle');
  test.setTimeout(90_000);
  await page.waitForTimeout(800);
  await capture(page, '__withPlane');
  // The same view with the plane off: what the grid adds is the difference.
  await toggle.click();
  await expect(body).toHaveAttribute('data-drawn', 'false');
  await page.waitForTimeout(800);
  await capture(page, '__without');
  const gridPixels = await changed(page, '__withPlane', '__without');
  expect(gridPixels).toBeGreaterThan(500);
  await toggle.click();
  await expect(body).toHaveAttribute('data-drawn', 'true');

  await canvas.evaluate((c) => {
    const ext = (c as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
    (window as unknown as { __olvLose: WEBGL_lose_context }).__olvLose = ext;
    ext.loseContext();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as unknown as { __olvLose: WEBGL_lose_context }).__olvLose.restoreContext());
  await expect(page.locator('.olv-toast-text')).toHaveText('Graphics context restored; the view has been redrawn.', { timeout: 10_000 });
  // The grid's CPU buffers upload to the rebuilt renderer: the restored frame
  // differs from the plane-off frame again (a frame without the grid would
  // differ by almost nothing).
  await expect.poll(async () => { await capture(page, '__restored'); return changed(page, '__restored', '__without'); }, { timeout: 15_000 }).toBeGreaterThan(gridPixels * 0.5);
  await expect(body).toHaveAttribute('data-drawn', 'true');
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('reference plane: the section is usable at 375 px and its rows wrap', async ({ page }) => {
    await page.goto('/');
    await dropHillsPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    const viewTab = page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="view"]');
    await expect(viewTab).toBeVisible({ timeout: 8_000 });
    await activate(viewTab);
    const section = page.locator('details.olv-section-collapsible', { has: page.locator('summary', { hasText: 'Reference plane' }) });
    await section.scrollIntoViewIfNeeded();
    await activate(section.locator('summary'));
    await activate(section.locator('.olv-refplane-toggle'));
    await activate(section.getByRole('button', { name: 'Use scan minimum' }));
    const body = section.locator('.olv-refplane-body');
    await expect(body).toHaveAttribute('data-drawn', 'true');
    await expect(body.locator('.olv-refplane-readout')).toContainText('Grid');
    // Nothing in the section is wider than the screen, and the controls are tappable.
    const overflow = await section.evaluate((el) => {
      const vw = window.innerWidth;
      return [...el.querySelectorAll('input, select, button, li')].filter((n) => n.getBoundingClientRect().right > vw + 1).length;
    });
    expect(overflow).toBe(0);
    for (const control of await body.locator('input:not([disabled]), select').all()) {
      const box = await control.boundingBox();
      if (box) expect(box.height, await control.evaluate((n) => n.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(24);
    }
    await section.locator('.olv-refplane-readout').scrollIntoViewIfNeeded();
    // A screenshot for review only when asked for, never to a fixed path.
    if (process.env.OLV_SHOT_DIR) await page.screenshot({ path: `${process.env.OLV_SHOT_DIR}/reference-plane-phone.png` });
  });
});

test('reference plane on the WebGPU backend @gpu', async ({ page }) => {
  await page.goto('/');
  await dropHillsPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  const backend = (await page.locator('.olv-backend-text').textContent()) ?? '';
  test.skip(!backend.includes('WebGPU'), `this runner draws with ${backend.trim() || 'an unknown backend'}, not WebGPU`);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !isBenignPageError(m.text())) errors.push(m.text()); });
  const litBefore = await litPixels(page);
  await placePlane(page);
  await page.waitForTimeout(500);
  expect(await litPixels(page)).toBeGreaterThan(litBefore * 1.05);
  expect(errors).toEqual([]);
});

type PickApi = {
  layerProjectPoints: (i: number) => Array<{ id: string; project: [number, number, number] }>;
  projectToClient: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null;
  pickAtClient: (x: number, y: number) => boolean;
};

test('reference plane: three points picked in perspective on known scan points', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?test=1');
  await dropHillsPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await waitForCameraSettled(page);
  const dismiss = page.locator('.olv-pc-dismiss');
  if (await dismiss.count()) await dismiss.first().click().catch(() => {});
  const section = await openSection(page);
  await section.locator('.olv-refplane-toggle').click();
  const body = section.locator('.olv-refplane-body');
  const status = body.locator('.olv-refplane-status');
  await body.getByRole('button', { name: 'Pick 3 points' }).click();
  await expect(status).toContainText('Click the first point');
  // Count the pointer events the canvas receives, to tell a click that never
  // arrived from one whose ray missed.
  await page.evaluate(() => {
    const w = window as unknown as { __pd: number; __pu: number };
    w.__pd = 0;
    w.__pu = 0;
    const c = document.querySelector('.olv-canvas')!;
    c.addEventListener('pointerdown', () => { w.__pd++; });
    c.addEventListener('pointerup', () => { w.__pu++; });
  });
  // Scan points (every 5th row and column of the 70 x 70 hills grid) whose
  // projected spot has the canvas on top: a card or panel over a point (the
  // Project ready card, at first) would take the click instead. Of those, the
  // three most spread out: leftmost, rightmost, and farthest from both.
  const spots = await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: PickApi }).__OLV_TEST_API__;
    const out: Array<{ i: number; x: number; y: number; picks: boolean }> = [];
    for (let r = 2; r < 70; r += 5) for (let c = 2; c < 70; c += 5) {
      const i = r * 70 + c;
      const p = api.layerProjectPoints(i)[0]?.project;
      const xy = p ? api.projectToClient({ x: p[0], y: p[1], z: p[2] }) : null;
      if (xy && document.elementFromPoint(xy.x, xy.y)?.tagName === 'CANVAS') out.push({ i, ...xy, picks: api.pickAtClient(xy.x, xy.y) });
    }
    return out;
  });
  expect(spots.length, 'scan points with the canvas on top').toBeGreaterThan(10);
  // Re-checked right before each click: a toast or chip can appear over a spot
  // between picks, and a covered spot never reaches the canvas.
  const uncovered = (): Promise<typeof spots> =>
    page.evaluate((all) => all.filter((q) => document.elementFromPoint(q.x, q.y)?.tagName === 'CANVAS'), spots);
  const chosen: typeof spots = [];
  const roles: Array<(c: typeof spots) => (typeof spots)[number]> = [
    (c) => c.reduce((a, b) => (b.x < a.x ? b : a)),
    (c) => c.reduce((a, b) => (b.x > a.x ? b : a)),
    (c) => c.reduce((a, b) => {
      const d = (q: typeof a) => Math.min(...chosen.map((h) => Math.hypot(q.x - h.x, q.y - h.y)));
      return d(b) > d(a) ? b : a;
    }),
  ];
  const prompts = ['Click the second point', 'Click the third point', 'passes through them exactly'];
  for (const [k, role] of roles.entries()) {
    const free = await uncovered();
    expect(free.length, `uncovered scan points before pick ${k + 1}`).toBeGreaterThan(0);
    const at = role(free);
    chosen.push(at);
    await page.mouse.click(at.x, at.y);
    const counts = await page.evaluate(() => {
      const w = window as unknown as { __pd: number; __pu: number };
      return `${w.__pd} down / ${w.__pu} up`;
    });
    await expect(status, `pick ${k + 1} (point ${at.i}): viewer pick hit=${at.picks}, canvas got ${counts}`).toContainText(prompts[k]);
  }
  await expect(body.locator('.olv-refplane-readout')).toContainText(/Orientation: Through 3 picked points, dip [\d.]+°/);
  await expect(body).toHaveAttribute('data-drawn', 'true');
});
