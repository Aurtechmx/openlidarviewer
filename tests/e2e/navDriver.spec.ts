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
 * A last test is the deterministic-lane smoke of the benchmark runner
 * (navJank.spec.ts): one short trajectory, the record built from it, the
 * nav-jank results file built from that, and both checked against the schema.
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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildNavJankRecord, validateJsonSchema } from '../../src/perf/navJankRecord';
import type { NavProbeSummary } from '../../src/perf/navProbe';
import { buildNavJankResults } from '../../scripts/lib/navJankResults.mjs';
import { dropTinyPly } from './helpers';

const SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../validation/performance/nav-jank.schema.json', import.meta.url)), 'utf8'),
);

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

async function run(page: Page, name: string, fixedStep: boolean, query = ''): Promise<{ drive: DriveResult; probe: ProbeSummary }> {
  // A fresh load per run, so every run starts from the framed view.
  await page.goto(`/?benchmark=nav${query}`);
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

  test('?governor=on installs the governor and leaves the fixed-step path unchanged', async ({ page }) => {
    test.setTimeout(240_000);
    const off = await run(page, 'flythrough', true);
    const on = await run(page, 'flythrough', true, '&governor=on');
    expect(await page.evaluate(() => typeof (window as { __olvGovernor?: { edl?: unknown } }).__olvGovernor?.edl)).toBe('function');
    expect(on.drive.settled).toBe(true);
    expect(on.probe.frames).toBeGreaterThan(0);
    expect(on.drive.trajectoryDigest).toBe(off.drive.trajectoryDigest);
    expect(on.drive.finalCameraDigest).toBe(off.drive.finalCameraDigest);
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

test('the benchmark runner builds a valid record from one trajectory', async ({ page }) => {
  test.setTimeout(120_000);
  const r = await run(page, 'stopInspect', false);
  const env = {
    commit: 'unknown', browser: 'chromium', os: process.platform, renderer: 'unknown', dpr: 1, refreshEstimateHz: 0,
    datasetSha256: 'unknown', trajectoryDigest: r.drive.trajectoryDigest, flags: ['benchmark=nav', 'frame-clock'],
  };
  const summary = r.probe as unknown as NavProbeSummary;
  const cold = buildNavJankRecord({ ...env, cache: 'cold' }, [{ name: 'stopInspect-cold-0', summary }]);
  const warm = buildNavJankRecord({ ...env, cache: 'warm' }, [{ name: 'stopInspect-warm-1', summary }]);
  expect(validateJsonSchema(SCHEMA, cold)).toEqual([]);
  expect(validateJsonSchema(SCHEMA, warm)).toEqual([]);
  const results = buildNavJankResults({
    generatedAt: new Date().toISOString(), machine: 'ci', dataset: { file: 'tiny.ply' },
    trajectories: { stopInspect: { cold, warm, loads: [] } },
  });
  expect(results.trajectories.stopInspect.trajectoryDigest).toBe(r.drive.trajectoryDigest);
  expect(results.trajectories.stopInspect.warmMedians?.frameP95Ms.n).toBe(1);
});
