/**
 * gpuDerivatives.spec.ts
 *
 * The GATE on the TerrainRasterEngine's real-WebGPU equivalence probe.
 *
 * HOW THIS DIFFERS FROM backendGpuLeg.spec.ts. That spec is the recorder: it
 * writes whatever the adapter did into a leg file and lets the comparator judge
 * it, so a GPU that disagreed with the CPU is a finding rather than a failure.
 * This spec is the gate: on a device that actually ran the kernels, a
 * divergence fails the run. The two read the same hook and assert different
 * things — the recorder never checks `probe.passed` or the error bounds, and
 * the gate never writes a file.
 *
 * WHAT COUNTS AS HAVING RUN. `executedBackend` is derived by `buildBackendLeg`
 * from the engine's own reason code, not from the fact that this spec asked for
 * a GPU, and `gpuClaimNotCredible` refuses a GPU claim that carries no adapter
 * descriptor read from `navigator.gpu`. Deriving it from the engine's `path`
 * would be wrong in the one case that matters: after a probe mismatch the path
 * is `cpu`, because falling back is the correct product behaviour, yet the GPU
 * did run and did produce the diverging numbers.
 *
 * WHEN THE RUNNER HAS NO ADAPTER. Headless Chromium exposes `navigator.gpu` and
 * returns null from `requestAdapter()`. There is nothing to gate, so the test
 * skips — but only after the engine has been driven to a reason code, and the
 * skip message carries that reason. It never skips because a wait quietly
 * expired. The real leg runs headed:
 *   npx playwright test tests/e2e/gpuDerivatives.spec.ts --project=gpu --headed
 *
 * @gpu — the outcome depends on the adapter the runner exposes, so this rides
 * the advisory project rather than blocking the build.
 */

import { test, expect } from '@playwright/test';
import { dropDenseGridPly } from './helpers';
import {
  buildBackendLeg,
  gpuClaimNotCredible,
  type AdapterDescriptor,
  type EngineReason,
} from '../../benchmarks/backends/record';
import { currentWorkload, measurementsFrom } from '../../benchmarks/backends/leg';
import {
  ASPECT_GATE_RAD,
  SCATTER_GATE,
  SHADE_GATE_LEVELS,
  SLOPE_GATE,
} from '../../benchmarks/backends/tolerances';

interface EngineStatus {
  path: 'cpu' | 'gpu';
  reason: string;
  probe: {
    passed: boolean;
    cells: number;
    comparedAspectCells: number;
    maxSlopeErr: number;
    maxAspectErr: number;
    maxShadeErr: number;
    coverageMatches: boolean;
    scatterExact: boolean | null;
    scatterCells: number;
  } | null;
}

/**
 * The verification hook, reached through a local cast rather than a global
 * `Window` augmentation: another spec already declares the same property with
 * its own shape, and two augmentations of one property do not merge.
 */
type EngineHookWindow = {
  __olvTerrainRasterEngine?: { init(): Promise<EngineStatus> };
};

test.describe('TerrainRasterEngine — real-WebGPU equivalence gate @gpu', () => {
  test('a GPU that ran must agree with the CPU reference', async ({ page }) => {
    // A sequence of bounded waits — scan load, analysis start, hook load, device
    // request. The default per-test budget is smaller than their sum.
    test.setTimeout(90_000);

    await page.goto('/?test=1');

    const hasWebGpu = await page.evaluate(() => 'gpu' in navigator);

    // The adapter descriptor, read from the browser rather than asserted here.
    // A GPU claim without one is refused below.
    const adapter = !hasWebGpu
      ? null
      : await page.evaluate<AdapterDescriptor | null>(async () => {
          try {
            const a = await navigator.gpu.requestAdapter();
            if (!a) return null;
            const info = a.info ?? { vendor: '', architecture: '', device: '', description: '' };
            return {
              vendor: info.vendor ?? '',
              architecture: info.architecture ?? '',
              device: info.device ?? '',
              description: info.description ?? '',
              features: [...a.features].sort(),
            };
          } catch {
            return null;
          }
        });

    // The engine module sits behind the terrain-analysis dynamic import, which
    // nothing pulls in until the analysis is actually STARTED. Opening a scan
    // mounts the Analyse panel and no more. Waiting for the hook after merely
    // loading a scan is what made this spec skip on every runner, headed
    // included, while reporting as a pass.
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    // The panel is revealed collapsed once a scan loads; expand it via its head.
    const panel = page.locator('.olv-analyse-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
      await panel.locator('.olv-panel-head').click();
    }
    await page.locator('.olv-analyse-run').click();

    // Not a skip. Starting the analysis is what loads the engine chunk, and
    // that does not depend on the runner's GPU — if the hook is absent here,
    // the chunk or this spec's path through the UI is broken, and reporting
    // that as "environment cannot run it" is how the spec went silent before.
    await page.waitForFunction(
      () => (window as unknown as EngineHookWindow).__olvTerrainRasterEngine !== undefined,
      undefined,
      { timeout: 20_000 },
    );

    // A headless build that exposes `navigator.gpu` with no working adapter can
    // leave the device request pending rather than rejecting. Race it so a
    // non-resolving probe becomes the engine's own `device-request-failed`
    // rather than a timeout.
    const raced = await page.evaluate(
      () =>
        Promise.race([
          (window as unknown as EngineHookWindow).__olvTerrainRasterEngine!.init(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
        ]),
    );
    const status: EngineStatus = raced ?? {
      path: 'cpu',
      reason: 'device-request-failed',
      probe: null,
    };

    // The engine must report a reason from its own vocabulary; a blank or
    // unknown one would leave the outcome unclassifiable, and every branch
    // below would be guessing.
    expect([
      'gpu-active',
      'webgpu-unavailable',
      'device-request-failed',
      'probe-mismatch',
      'gpu-dispatch-failed',
    ]).toContain(status.reason);

    // `executedBackend` comes out of the engine's reason via the same function
    // the leg recorder uses, so "did a GPU compute these numbers" is answered
    // identically in both specs.
    const leg = buildBackendLeg({
      legId: 'gpu-gate',
      environment: 'browser',
      requestedBackend: 'gpu',
      reason: status.reason as EngineReason,
      path: status.path,
      adapter,
      commit: null,
      workload: currentWorkload(),
      measurements: status.probe === null ? null : measurementsFrom(status.probe),
      runtime: 'playwright',
    });

    // A GPU claim standing on no adapter descriptor and no measurements is not
    // evidence of anything, and is the one way this gate could report success
    // over an empty run.
    expect(gpuClaimNotCredible(leg)).toBeNull();

    if (leg.executedBackend !== 'gpu') {
      test.skip(
        true,
        `backend-unavailable: no GPU executed the probe (engine reason: ${status.reason}, adapter: ${adapter === null ? 'none' : adapter.vendor || 'unnamed'})`,
      );
      return;
    }

    // From here a real device ran the kernels, so the equivalence contract is
    // in force. A mismatch is the divergence the honesty contract forbids.
    expect(status.reason).not.toBe('probe-mismatch');
    expect(status.reason).not.toBe('gpu-dispatch-failed');
    expect(status.reason).toBe('gpu-active');

    const probe = status.probe!;
    expect(probe.passed).toBe(true);
    expect(probe.cells).toBe(64 * 64);
    expect(probe.comparedAspectCells).toBeGreaterThan(0);
    expect(probe.coverageMatches).toBe(true);
    expect(probe.maxSlopeErr).toBeLessThanOrEqual(SLOPE_GATE);
    expect(probe.maxAspectErr).toBeLessThanOrEqual(ASPECT_GATE_RAD);
    expect(probe.maxShadeErr).toBeLessThanOrEqual(SHADE_GATE_LEVELS);
    // Phase-2 DTM scatter (min/count) is integer-stable, so on a real device it
    // must be EXACT — never merely close.
    expect(SCATTER_GATE).toBe(0);
    expect(probe.scatterExact).toBe(true);
    expect(probe.scatterCells).toBeGreaterThan(0);
  });
});
