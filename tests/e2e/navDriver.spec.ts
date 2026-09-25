/**
 * navDriver.spec.ts: `?benchmark=nav` replays scripted trajectories.
 *
 * Opens a small scan and plays every trajectory through
 * `window.__olvNavDriver`: twice with the frame clock's real delta and twice
 * with the fixed navigation step, each on a fresh load of the scan. The
 * trajectory digest must match across runs, and in fixed-step mode so must
 * the final camera digest. Real-delta final digests are attached to the
 * report, not asserted: they follow frame timing. The probe must have
 * recorded the dispatched input and the frames. No timing is asserted.
 *
 * The scan is `tiny.ply`: on the runner's software renderer a drag over the
 * multichunk LAZ fixture outlasts the test timeout.
 *
 * The full matrix (every trajectory, two fixed-step and two real-delta runs)
 * is tagged @bench and runs with `npm run test:e2e:bench` on a machine with
 * a GPU: on a software renderer the longer trajectories outlast the test
 * timeout. The deterministic lane keeps one fixed-step replay check on
 * the shortest trajectory.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly } from './helpers';

const NAMES = ['orbit', 'flythrough', 'zoomShock', 'scrub', 'stopInspect'] as const;

interface DriveResult {
  trajectoryDigest: string;
  startCameraDigest: string;
  finalCameraDigest: string;
  steps: number;
  settled: boolean;
  unsettledAt: string | null;
  frames: number;
}

interface ProbeSummary { frames: number; inputToDrawMs: { samples: number } }

async function run(page: Page, name: string, fixedStep: boolean): Promise<{ drive: DriveResult; probe: ProbeSummary }> {
  // A fresh load per run, so every run starts from the framed view.
  await page.goto('/?benchmark=nav');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForFunction(() => Boolean((window as { __olvNavDriver?: unknown }).__olvNavDriver));
  await page.waitForTimeout(500);
  return page.evaluate(async ({ name, fixedStep }) => {
    const w = window as unknown as {
      __olvNavProbe: { stop(n?: string): unknown; start(): void };
      __olvNavDriver: { run(n: string, o: { fixedStep: boolean }): Promise<DriveResult> };
    };
    w.__olvNavProbe.stop();
    w.__olvNavProbe.start();
    const drive = await w.__olvNavDriver.run(name, { fixedStep });
    const probe = w.__olvNavProbe.stop(name) as ProbeSummary;
    return { drive, probe };
  }, { name, fixedStep });
}

test.describe('nav driver', () => {
  test('replays flythrough to the same pose in fixed-step mode', async ({ page }) => {
    test.setTimeout(240_000);
    const a = await run(page, 'flythrough', true);
    const b = await run(page, 'flythrough', true);
    for (const r of [a, b]) {
      expect(r.drive.trajectoryDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(r.drive.settled).toBe(true);
      expect(r.probe.frames).toBeGreaterThan(0);
      expect(r.probe.inputToDrawMs.samples).toBeGreaterThan(0);
    }
    expect(b.drive.trajectoryDigest).toBe(a.drive.trajectoryDigest);
    expect(b.drive.startCameraDigest).toBe(a.drive.startCameraDigest);
    expect(b.drive.finalCameraDigest).toBe(a.drive.finalCameraDigest);
    expect(a.drive.finalCameraDigest).not.toBe(a.drive.startCameraDigest);
  });

  for (const name of NAMES) {
    test(`replays ${name} deterministically @bench`, async ({ page }, info) => {
      test.setTimeout(240_000);
      const fixedA = await run(page, name, true);
      const fixedB = await run(page, name, true);
      const realA = await run(page, name, false);
      const realB = await run(page, name, false);

      for (const r of [fixedA, fixedB, realA, realB]) {
        expect(r.drive.trajectoryDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(r.drive.trajectoryDigest).toBe(fixedA.drive.trajectoryDigest);
        expect(r.drive.settled).toBe(true);
        expect(r.probe.frames).toBeGreaterThan(0);
        expect(r.probe.inputToDrawMs.samples).toBeGreaterThan(0);
      }
      expect(fixedB.drive.startCameraDigest).toBe(fixedA.drive.startCameraDigest);
      expect(fixedB.drive.finalCameraDigest).toBe(fixedA.drive.finalCameraDigest);
      // The trajectory moved the camera.
      expect(fixedA.drive.finalCameraDigest).not.toBe(fixedA.drive.startCameraDigest);

      const realDt = realA.drive.finalCameraDigest === realB.drive.finalCameraDigest ? 'same' : 'differs';
      info.annotations.push({ type: 'real-dt-final-pose', description: realDt });
      console.log(`[nav-driver] ${name}: real-dt final pose ${realDt}`);
    });
  }
});
