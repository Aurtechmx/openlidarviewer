/**
 * backendGpuLeg.spec.ts
 *
 * The GPU leg of the backend-equivalence suite, taken where a WebGPU adapter
 * exists.
 *
 * WHY THIS IS A BROWSER SPEC AND NOT A VITEST FILE. There is no WebGPU adapter
 * in Node. A vitest "GPU vs CPU" comparison there runs the engine's fallback,
 * compares the CPU reference against itself, and reports agreement — every
 * number real, the conclusion worthless. The browser is the only place the
 * question can be answered, so the leg is recorded here and the comparator in
 * `benchmarks/backends/` reads the file this spec writes.
 *
 * WHAT IS RECORDED. The spec drives the engine's verification hook, which
 * initialises the engine on the real device and runs the once-per-session
 * equivalence probe: the same deterministic surface through `hornSlopeAspect`
 * in f64 and through the WGSL kernels in f32, over square cells, anisotropic
 * cells and a foot vertical unit, plus a hillshade pass and a 6000-point
 * min/count scatter. What crosses back is the engine's own compute status —
 * path, reason, and the raw per-cell maxima — plus the adapter the browser
 * reported. The record's `executedBackend` is derived from the reason, never
 * from what the spec asked for.
 *
 * WHEN THE RUNNER HAS NO ADAPTER. The leg is still written, with
 * `executedBackend: 'cpu'` and the engine's reason, and the comparator reports
 * `backend-unavailable`. The spec does not skip silently and it does not fail:
 * an absent adapter is a fact about the runner, and recording it is how the
 * report ends up saying the question was not answered rather than saying
 * nothing.
 *
 * @gpu — the outcome depends on the adapter the runner exposes, so this rides
 * the advisory project rather than blocking the build.
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { dropDenseGridPly } from './helpers';
import { legFromComputeStatus } from '../../benchmarks/backends/leg';
import { GPU_LEG_FILE, writeComparison, writeLeg } from '../../benchmarks/backends/writer';
import type { AdapterDescriptor, EngineReason } from '../../benchmarks/backends/record';

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

function currentCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

test.describe('backend equivalence: the GPU leg @gpu', () => {
  test('record what a real WebGPU adapter computed, or record that there was none', async ({
    page,
  }) => {
    // A sequence of bounded waits — scan load, hook load, device request — each
    // of which resolves to a recordable outcome. The default per-test budget is
    // smaller than their sum, so on a headless runner the budget would expire
    // before the last one could report its own result.
    test.setTimeout(90_000);

    await page.goto('/?test=1');

    const commit = currentCommit();
    const userAgent = await page.evaluate(() => navigator.userAgent);

    /** Write the leg and rebuild the comparison. Called on every path out. */
    const record = (status: EngineStatus, adapter: AdapterDescriptor | null): EngineStatus => {
      const leg = legFromComputeStatus(
        // The reason crosses the browser boundary as a plain string. Narrowed
        // here, and the assertion below refuses any value outside the engine's
        // own vocabulary, so an unrecognised reason fails rather than being
        // filed under whichever branch catches it.
        { path: status.path, reason: status.reason as EngineReason, probe: status.probe },
        {
          legId: 'gpu-browser',
          environment: 'browser',
          requestedBackend: 'gpu',
          adapter,
          commit,
          runtime: userAgent,
        },
      );
      writeLeg(leg, GPU_LEG_FILE);
      writeComparison();
      return status;
    };

    const hasWebGpu = await page.evaluate(() => 'gpu' in navigator);
    if (!hasWebGpu) {
      const status = record({ path: 'cpu', reason: 'webgpu-unavailable', probe: null }, null);
      expect(status.path).toBe('cpu');
      return;
    }

    // The adapter descriptor, read from the browser rather than asserted by the
    // spec. A GPU claim without one is refused by the comparator.
    const adapter = await page.evaluate<AdapterDescriptor | null>(async () => {
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
    // nothing pulls in until the analysis is actually started. Opening a scan
    // mounts the Analyse panel and no more, so the run has to be triggered for
    // the verification hook to exist at all.
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

    const hookReady = await page
      .waitForFunction(() => (window as unknown as EngineHookWindow).__olvTerrainRasterEngine !== undefined, undefined, {
        timeout: 15_000,
      })
      .then(() => true)
      .catch(() => false);
    if (!hookReady) {
      // Nothing was measured and nothing is claimed. `not-initialised` is the
      // engine's own word for this state.
      record({ path: 'cpu', reason: 'not-initialised', probe: null }, adapter);
      test.skip(true, 'terrain engine module not loaded (analysis chunk did not initialise)');
      return;
    }

    // A headless build that exposes `navigator.gpu` with no working adapter can
    // leave the device request pending rather than rejecting. Race it so a
    // non-resolving probe becomes a recorded unavailability instead of a
    // timeout that records nothing.
    const raced = await page.evaluate(
      () =>
        Promise.race([
          (window as unknown as EngineHookWindow).__olvTerrainRasterEngine!.init(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
        ]),
    );
    const status = record(
      raced ?? { path: 'cpu', reason: 'device-request-failed', probe: null },
      adapter,
    );

    // The engine must report a reason from its own vocabulary; a blank or
    // unknown one would leave the record unclassifiable.
    expect([
      'gpu-active',
      'webgpu-unavailable',
      'device-request-failed',
      'probe-mismatch',
    ]).toContain(status.reason);

    // A GPU that ran must have produced measurements; a session reported as
    // active with no probe behind it is not evidence of anything.
    if (status.reason === 'gpu-active' || status.reason === 'probe-mismatch') {
      expect(status.probe).not.toBeNull();
      expect(status.probe!.cells).toBe(64 * 64);
      expect(status.probe!.comparedAspectCells).toBeGreaterThan(0);
    }
  });
});
