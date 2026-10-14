import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, waitForCameraSettled } from './helpers';

/**
 * Target size of the ViewCube's click targets (WCAG 2.2 SC 2.5.8, 24 CSS px).
 * At each camera orientation, every shown face, edge, corner and Home button is
 * measured as rendered: it must be at least 24x24, or its 24 px circle must
 * touch no other shown target. The layout itself is unit-tested in
 * viewCubeMath.test.ts; this checks the CSS actually delivers it.
 */

const MIN = 24;
// Camera offsets from the target (east, north, up): default, straight-on, glancing and oblique.
const OFFSETS: readonly [string, [number, number, number]][] = [
  ['default', [0, -1, 0]],
  ['top', [0, 0.0001, 1]],
  ['glancing front', [0.02, -1, 0.02]],
  ['glancing right', [1, -0.05, 0.12]],
  ['glancing left', [-1, 0.1, 0.05]],
  ['low back', [0.1, 1, 0.03]],
  ['oblique', [0.6, -0.6, 0.5]],
  ['steep', [0.15, -0.1, 1]],
];

interface Box { id: string; left: number; top: number; right: number; bottom: number }

async function shownTargets(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const out: { id: string; left: number; top: number; right: number; bottom: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.olv-viewcube button')) {
      const cs = getComputedStyle(el);
      if (el.hidden || cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      out.push({ id: el.getAttribute('data-testid') ?? '?', left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    return out;
  });
}

function violations(boxes: Box[]): string[] {
  const bad: string[] = [];
  for (const b of boxes) {
    const w = b.right - b.left;
    const h = b.bottom - b.top;
    if (w >= MIN - 0.01 && h >= MIN - 0.01) continue;
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    const crowded = boxes.some((o) => {
      if (o === b) return false;
      const dx = Math.max(o.left - cx, 0, cx - o.right);
      const dy = Math.max(o.top - cy, 0, cy - o.bottom);
      return Math.hypot(dx, dy) < MIN / 2;
    });
    if (crowded) bad.push(`${b.id} ${w.toFixed(1)}x${h.toFixed(1)} with a neighbour inside its 24px circle`);
  }
  return bad;
}

test.describe('view cube target size', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('every shown target is 24px or has the spacing exemption, at default and glancing orientations', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-viewcube')).toBeVisible({ timeout: 20_000 });
    await waitForCameraSettled(page);
    for (const [name, off] of OFFSETS) {
      await page.evaluate((o) => {
        const api = (window as unknown as { __OLV_TEST_API__: { getCameraPose: () => { position: number[]; target: number[] }; applyCameraPose: (p: unknown) => void } }).__OLV_TEST_API__;
        const p = api.getCameraPose();
        const d = Math.hypot(p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]) || 1;
        const n = Math.hypot(o[0], o[1], o[2]);
        api.applyCameraPose({ target: p.target, position: [0, 1, 2].map((i) => p.target[i] + (o[i] / n) * d) });
      }, off);
      await waitForCameraSettled(page);
      await page.waitForTimeout(100);
      const boxes = await shownTargets(page);
      expect(boxes.length, `${name}: some target is shown`).toBeGreaterThan(1);
      expect(violations(boxes), `${name}: undersized targets without spacing`).toEqual([]);
    }
  });
});
