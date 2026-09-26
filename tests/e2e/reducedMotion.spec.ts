import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * reducedMotion.spec.ts: `prefers-reduced-motion: reduce` stops camera motion
 * the user did not drive.
 *
 *   - a released orbit drag does not glide on (no inertia);
 *   - a camera preset lands at once instead of playing its ~0.8 s tween.
 *
 * The camera oracle is the `__olvNavDrive` slot (src/perf/navProbeHook.ts):
 * NavController reports the pose into its `poseAfter` at the end of every
 * navigation update, so the spec installs a recording sink with no app-side
 * hook and no clipboard (which WebKit cannot read). The end of the update is
 * the pose the camera rests at: the render loop sleeps once the scene is
 * quiet, so a pose read at the start of an update (`pose`) can stay one
 * update behind for as long as the loop sleeps, which read as a pose between
 * the two presets on a loaded WebKit runner.
 */

type Pose = number[];

async function loadReduced(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await page.evaluate(() => {
    const w = window as unknown as { __olvPoses: number[][]; __olvNavDrive: unknown };
    w.__olvPoses = [];
    w.__olvNavDrive = {
      fixedDtSec: null,
      takeSteps: () => 0,
      pose: () => {},
      poseAfter: (p: number[], t: number[]) => { w.__olvPoses.push([...p, ...t]); },
    };
  });
}

/** The newest pose the navigation loop reported, after the loop has had time to run. */
async function latestPose(page: Page): Promise<Pose> {
  await page.waitForFunction(() => (window as unknown as { __olvPoses: number[][] }).__olvPoses.length > 0);
  return page.evaluate(() => {
    const p = (window as unknown as { __olvPoses: number[][] }).__olvPoses;
    return p[p.length - 1];
  });
}

/**
 * The pose once the navigation loop has reported it unchanged across two
 * reads 300 ms apart, after a report newer than `mark`. A slow runner can report the
 * pose from before the last click for a frame or two, so a single read can
 * be stale.
 */
async function settledPose(page: Page, mark: number): Promise<Pose> {
  await page.waitForFunction((m) => (window as unknown as { __olvPoses: number[][] }).__olvPoses.length > m, mark);
  let prev = await latestPose(page);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(300);
    const cur = await latestPose(page);
    if (moved(prev, cur) < 1e-9) return cur;
    prev = cur;
  }
  throw new Error('the camera pose never settled');
}

function moved(a: Pose, b: Pose): number {
  return Math.max(...a.map((v, i) => Math.abs(v - b[i]) / Math.max(1, Math.abs(v))));
}

async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('.olv-canvas').boundingBox();
  if (!box) throw new Error('no canvas box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('prefers-reduced-motion', () => {
  test('a released orbit drag does not glide on', async ({ page }) => {
    await loadReduced(page);
    const c = await canvasCenter(page);
    // A hover wakes the sleeping loop, so it reports the resting pose.
    await page.mouse.move(c.x, c.y);
    const before = await settledPose(page, 0);
    await page.mouse.down();
    // A fast flick: the kind of release that glides without reduced motion.
    for (let i = 1; i <= 8; i++) await page.mouse.move(c.x + i * 30, c.y + i * 4);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const released = await latestPose(page);
    expect(moved(before, released), 'the drag itself moved the camera').toBeGreaterThan(1e-4);
    await page.waitForTimeout(700);
    const later = await latestPose(page);
    expect(moved(released, later), 'no inertial glide after release').toBeLessThan(1e-6);
  });

  test('a camera preset lands without a long tween', async ({ page }) => {
    await loadReduced(page);
    const chip = (name: string) =>
      page.locator('.olv-cam-views .olv-cam-chip').filter({ hasText: new RegExp(`^${name}$`) });
    const toast = page.locator('.olv-lasso-toast');
    // Start from a known pose that differs from Top: the framed view after
    // open can already be at (or near) the Top pose on some viewports.
    const beforeFront = await page.evaluate(() => (window as unknown as { __olvPoses: number[][] }).__olvPoses.length);
    await chip('Front').click();
    await expect(toast).toHaveText('View · Front.');
    const from = await settledPose(page, beforeFront);
    const mark = await page.evaluate(() => (window as unknown as { __olvPoses: number[][] }).__olvPoses.length);

    await chip('Top').click();
    await expect(toast).toHaveText('View · Top.');
    // Wait on the loop having reported a pose that differs from Front (the
    // real signal the preset applied), then let it run on for well over a
    // tween's length.
    await page.waitForFunction(
      ({ mark, from }) => {
        const p = (window as unknown as { __olvPoses: number[][] }).__olvPoses.slice(mark);
        return p.some((q) => q.some((v, i) => Math.abs(v - from[i]) / Math.max(1, Math.abs(v)) > 1e-4));
      },
      { mark, from },
      { timeout: 10_000 },
    );
    await page.waitForTimeout(1_000);
    const after = await page.evaluate(
      (mark) => (window as unknown as { __olvPoses: number[][] }).__olvPoses.slice(mark),
      mark,
    );
    const landed = after[after.length - 1];
    expect(moved(from, landed), 'the preset moved the camera').toBeGreaterThan(1e-4);
    // No tween: every reported pose is either the Front pose or the Top pose,
    // never one in between. A 0.8 s eased tween reports many in-between poses.
    const between = after.filter((q) => moved(from, q) > 1e-6 && moved(landed, q) > 1e-6);
    expect(between, 'no in-between tween poses').toEqual([]);
  });
});
