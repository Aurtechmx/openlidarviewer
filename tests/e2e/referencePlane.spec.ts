import { test, expect, type Page, type Locator } from '@playwright/test';
import { activate, dropHillsPly, framedScanCentre, pinNavigationPanel, waitForCameraSettled } from './helpers';
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

  // Back to perspective, then three points picked on the scan, well apart,
  // above the Navigation panel.
  await views.locator('.olv-plan-toggle').click();
  await expect(views.locator('.olv-plan-toggle')).toHaveAttribute('aria-pressed', 'false');
  await waitForCameraSettled(page);
  await body.getByRole('button', { name: 'Pick 3 points' }).click();
  await expect(body.locator('.olv-refplane-status')).toContainText('Click the first point');
  const c = await framedScanCentre(page);
  const status = body.locator('.olv-refplane-status');
  const prompts = ['Click the second point', 'Click the third point', 'passes through them exactly'];
  // Offsets where the canvas itself is under the pointer, not a card or panel.
  const onCanvas = await page.evaluate(({ x, y }) => {
    const out: Array<[number, number]> = [];
    for (let dy = -300; dy <= 300; dy += 20) for (let dx = -400; dx <= 400; dx += 20) {
      if (document.elementFromPoint(x + dx, y + dy)?.tagName === 'CANVAS') out.push([dx, dy]);
    }
    return out;
  }, c);
  // A miss reports "No scan point" and keeps the pick open, so try the canvas
  // spots nearest each wanted offset until one lands on the scan.
  const wants: Array<[number, number]> = [[-80, -60], [80, -60], [0, 60]];
  for (const [i, want] of wants.entries()) {
    const order = [...onCanvas].sort((p, q) => Math.hypot(p[0] - want[0], p[1] - want[1]) - Math.hypot(q[0] - want[0], q[1] - want[1]));
    let landed = false;
    // Every canvas spot, nearest first: a slow software renderer can frame the
    // scan smaller or off centre, and a miss costs one click.
    for (const [dx, dy] of order) {
      await page.mouse.click(c.x + dx, c.y + dy);
      if ((await status.textContent())?.includes(prompts[i])) { landed = true; break; }
    }
    expect(landed, `pick ${i + 1} found a scan point`).toBe(true);
  }
  await expect(readout).toContainText(/Orientation: Through 3 picked points, dip [\d.]+°/);
  await expect(body.locator('select').first()).toHaveValue('three-point');
  await expect(body).toHaveAttribute('data-drawn', 'true');

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
