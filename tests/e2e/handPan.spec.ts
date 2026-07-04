import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * tests/e2e/handPan.spec.ts
 *
 * Integration coverage for the v0.5.5 P1 hand tool (pan mode) — the DOM +
 * keyboard + pointer wiring. The drag GEOMETRY (grabbed point stays under
 * the pointer, camera-target distance preservation, high-coordinate
 * stability) is pinned numerically by tests/panMath.test.ts; what this spec
 * asserts is the integration surface:
 *
 *   - the Pan pad mounts next to the mode triangle with a stable label and
 *     aria-pressed reflecting the active mode;
 *   - Digit4 selects pan, G toggles pan ⇄ orbit;
 *   - a primary drag in pan mode moves the camera (share-link pose oracle,
 *     same idiom as touchGesture.spec.ts) without page errors;
 *   - middle-mouse drag pans in orbit mode WITHOUT changing the mode;
 *   - a mode switch mid-drag cancels safely;
 *   - `?handPan=off` hides the pad and disables the bindings.
 */

async function loadSample(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

/** The share-link pose is the camera oracle — it changes iff the camera did. */
async function readPose(page: Page): Promise<string> {
  await page.locator('.olv-tool', { hasText: 'Copy view link' }).click();
  await page.waitForTimeout(200);
  return page.evaluate(() =>
    navigator.clipboard.readText().catch(() => window.location.hash),
  );
}

async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('.olv-canvas').boundingBox();
  if (!box) throw new Error('no canvas box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('hand tool — pan mode surfaces', () => {
  test('the Pan pad mounts with a stable label and aria-pressed', async ({ page }) => {
    await loadSample(page);
    const pan = page.locator('.olv-mode-pan');
    await expect(pan).toBeVisible();
    await expect(pan).toHaveText(/Pan/);
    await expect(pan).toHaveAttribute('aria-pressed', 'false');

    await pan.click();
    await expect(pan).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.olv-mode-orbit')).toHaveAttribute('aria-pressed', 'false');
    // The canvas advertises the grab affordance while the tool is idle.
    await expect(page.locator('.olv-canvas')).toHaveCSS('cursor', 'grab');

    // Selecting orbit again releases the pad and the cursor.
    await page.locator('.olv-mode-orbit').click();
    await expect(pan).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.olv-canvas')).not.toHaveCSS('cursor', 'grab');
  });

  test('Digit4 selects pan; G toggles pan and back to orbit', async ({ page }) => {
    await loadSample(page);
    const pan = page.locator('.olv-mode-pan');

    await page.keyboard.press('4');
    await expect(pan).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('g');
    await expect(pan).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.olv-mode-orbit')).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('g');
    await expect(pan).toHaveAttribute('aria-pressed', 'true');
  });

  test('a primary drag in pan mode moves the camera without errors', async ({ page }) => {
    await loadSample(page);
    let pageError: Error | null = null;
    page.on('pageerror', (e) => (pageError = e));

    await page.locator('.olv-mode-pan').click();
    const before = await readPose(page);

    const c = await canvasCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(c.x + i * 14, c.y + i * 6);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);

    const after = await readPose(page);
    expect(after).not.toEqual(before);
    expect(pageError).toBeNull();
  });

  test('middle-mouse drag pans in orbit mode and the mode is untouched', async ({ page }) => {
    await loadSample(page);
    const orbit = page.locator('.olv-mode-orbit');
    await expect(orbit).toHaveAttribute('aria-pressed', 'true');
    const before = await readPose(page);

    const c = await canvasCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down({ button: 'middle' });
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(c.x - i * 12, c.y + i * 8);
    }
    await page.mouse.up({ button: 'middle' });
    await page.waitForTimeout(400);

    const after = await readPose(page);
    expect(after).not.toEqual(before);
    // Temporary grab: the prior behavior (orbit mode) is restored — it was
    // never left.
    await expect(orbit).toHaveAttribute('aria-pressed', 'true');
  });

  test('a mode switch mid-drag cancels the grab safely', async ({ page }) => {
    await loadSample(page);
    let pageError: Error | null = null;
    page.on('pageerror', (e) => (pageError = e));

    await page.locator('.olv-mode-pan').click();
    const c = await canvasCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 60, c.y + 20);
    // Switch modes while the button is still held.
    await page.keyboard.press('1');
    await expect(page.locator('.olv-mode-orbit')).toHaveAttribute('aria-pressed', 'true');
    // Further movement and release must be inert and error-free.
    await page.mouse.move(c.x + 160, c.y + 60);
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(pageError).toBeNull();
    await expect(page.locator('.olv-canvas')).not.toHaveCSS('cursor', 'grabbing');
  });

  test('?handPan=off hides the pad and disables Digit4/G', async ({ page }) => {
    await loadSample(page, '/?handPan=off');
    await expect(page.locator('.olv-mode-pan')).toBeHidden();
    await expect(page.locator('.olv-mode')).toHaveCount(4); // pad exists, hidden

    const orbit = page.locator('.olv-mode-orbit');
    await page.keyboard.press('4');
    await expect(orbit).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('g');
    await expect(orbit).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.olv-canvas')).not.toHaveCSS('cursor', 'grab');
  });
});
