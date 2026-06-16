import { test, expect } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * REAL-GPU verification gate for the TerrainRasterEngine (deferred from the
 * Node suite — vitest has no WebGPU; there the kernels are validated via the
 * f32 transcription harness and a mock device, see
 * tests/terrainRasterEngine.test.ts / tests/gpuBackendDispatch.test.ts).
 *
 * What this spec asserts, on a browser that actually has WebGPU:
 *   - the engine's once-per-session equivalence probe (64×64 synthetic grid,
 *     CPU f64 reference vs WGSL f32 kernels, 1e-4 slope/aspect gate, ±1 shade)
 *     PASSES on the real device — a 'probe-mismatch' here is precisely the
 *     divergence the honesty contract forbids, so it fails loudly;
 *   - a fallback for a legitimate reason (no WebGPU, no adapter) is accepted
 *     and must be RECORDED in the compute-path telemetry.
 *
 * Self-skips (honestly, with the reason) when the environment can't run it:
 * headless CI sandboxes often expose no WebGPU adapter, and the engine module
 * (whose debug hook this drives) only loads with the analysis chunk after a
 * scan is opened. Run locally with a real GPU for the verification to bite:
 *   npx playwright test tests/e2e/gpuDerivatives.spec.ts
 */

interface EngineHook {
  init(): Promise<{
    path: 'cpu' | 'gpu';
    reason: string;
    probe: {
      passed: boolean;
      maxSlopeErr: number;
      maxAspectErr: number;
      maxShadeErr: number;
      cells: number;
      scatterExact: boolean | null;
      scatterCells: number;
    } | null;
  }>;
}

declare global {
  interface Window {
    __olvTerrainRasterEngine?: EngineHook;
  }
}

test.describe('TerrainRasterEngine — real-WebGPU equivalence probe', () => {
  test('the per-session probe passes on a real device (or falls back for a recorded reason)', async ({
    page,
  }) => {
    await page.goto('/?test=1');

    const hasWebGpu = await page.evaluate(() => 'gpu' in navigator);
    test.skip(!hasWebGpu, 'WebGPU is unavailable in this browser build');

    // Load a scan so the analysis chunk (and with it the engine module +
    // debug hook) is pulled in — the engine is not part of the boot bundle.
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    const hookReady = await page
      .waitForFunction(() => window.__olvTerrainRasterEngine !== undefined, undefined, {
        timeout: 30_000,
      })
      .then(() => true)
      .catch(() => false);
    test.skip(
      !hookReady,
      'terrain engine module not loaded (analysis chunk did not initialise in time)',
    );

    // init() requests a real WebGPU adapter/device. In a headless build that
    // exposes `navigator.gpu` but has no working adapter, that request can HANG
    // rather than reject — which would blow the whole test's 30 s budget. Race
    // it against an in-page deadline so a non-resolving probe becomes an honest
    // skip (the same "environment can't run it" outcome the spec documents),
    // not a failure. A real device resolves in well under a second, so this
    // never masks a genuine probe result.
    const raced = await page.evaluate(
      () =>
        Promise.race([
          window.__olvTerrainRasterEngine!.init(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
        ]),
    );
    test.skip(
      raced === null,
      'WebGPU adapter/device request did not resolve in this environment (headless probe hang)',
    );
    const info = raced!;

    // The one outcome the honesty contract forbids: a GPU that disagrees
    // with the CPU truth. Legitimate fallbacks remain acceptable — but they
    // must carry their reason.
    expect(info.reason).not.toBe('probe-mismatch');
    expect(['gpu-active', 'webgpu-unavailable', 'device-request-failed']).toContain(info.reason);

    if (info.path === 'gpu') {
      // Probe evidence must exist and sit inside the equivalence gate.
      expect(info.probe).not.toBeNull();
      expect(info.probe!.passed).toBe(true);
      expect(info.probe!.cells).toBe(64 * 64);
      expect(info.probe!.maxSlopeErr).toBeLessThanOrEqual(1e-4);
      expect(info.probe!.maxAspectErr).toBeLessThanOrEqual(1e-4);
      expect(info.probe!.maxShadeErr).toBeLessThanOrEqual(1);
      // Phase-2 DTM scatter (min/count) is integer-stable, so on a real
      // device it must be EXACT — never merely close. A 'false' here is the
      // same forbidden divergence as a derivative mismatch.
      expect(info.probe!.scatterExact).not.toBe(false);
      if (info.probe!.scatterExact === true) {
        expect(info.probe!.scatterCells).toBeGreaterThan(0);
      }
    } else {
      // CPU fallback: fine, silent to the user, but recorded — never blank.
      expect(info.reason.length).toBeGreaterThan(0);
    }
  });
});
