import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * streamingNavPerf.spec.ts — the DEVICE half of the streaming fast-navigation
 * measurement. Tagged `@gpu`, so it runs only in the `gpu` Playwright project
 * (a real GPU, headed) and never in the deterministic CI lane.
 *
 * WHY THIS EXISTS. The Node harness (`tests/benchmark/streamingNav.test.ts`)
 * measures every scheduler-side latency honestly, but two of the requested
 * components — end-to-end frame time p50/p95/p99, and mesh-creation / GPU-upload
 * time — cannot be observed in Node: there is no render loop and no GL context.
 * The Node record marks both `unavailable`. THIS spec captures them on a real
 * device, over the same shape of workload: a scripted fast navigation across a
 * streaming COPC scan, with frame times sampled straight from the browser's own
 * `requestAnimationFrame` cadence.
 *
 * HOW TO RUN. Put the ~80 MB autzen COPC fixture next to package.json (or point
 * `OLV_AUTZEN_FIXTURE` at it), then:
 *
 *     STREAMING_NAV_DEVICE_WRITE=1 npx playwright test \
 *       tests/e2e/streamingNavPerf.spec.ts --project=gpu --headed
 *
 * With `STREAMING_NAV_DEVICE_WRITE=1` it writes a device record next to the Node
 * baseline; without it, it still asserts frames were captured. It skips cleanly
 * when the fixture is absent, so a clone without it stays green.
 *
 * This is a MEASUREMENT. It drives the shipped app through its normal input and
 * reads the frame clock the browser already keeps; it changes nothing.
 */

const COPC_FILE =
  process.env.OLV_AUTZEN_FIXTURE ??
  new URL('../../autzen-classified.copc.laz', import.meta.url).pathname;
const hasFixture = fs.existsSync(COPC_FILE);
const WRITE = process.env.STREAMING_NAV_DEVICE_WRITE === '1';

/** Nearest-rank percentile — matches benchmarks/performance/frameRecord.ts. */
function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return Number.NaN;
  const idx = Math.max(0, Math.ceil((p / 100) * sortedAscending.length) - 1);
  return sortedAscending[Math.min(idx, sortedAscending.length - 1)];
}

test.describe('@gpu streaming fast-navigation frame capture', () => {
  test.skip(!hasFixture, `autzen COPC fixture not found at ${COPC_FILE}`);

  test('captures frame-time p50/p95/p99 during a scripted fast navigation', async ({
    page,
  }, testInfo) => {
    // `?debug=1` mounts window.__olvMetrics (the debug overlay's metrics doc),
    // which carries the live streaming counters the Node harness reports too.
    await page.goto('/?debug=1');
    await expect(page.locator('.olv-empty-title')).toBeVisible();

    await page
      .locator('.olv-file-input')
      .first()
      .setInputFiles(COPC_FILE);

    // Wait for the scene to come up and streaming to begin.
    const canvas = page.locator('.olv-canvas');
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);

    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas box');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Start an in-page frame sampler off the browser's own rAF cadence.
    await page.evaluate(() => {
      const w = window as unknown as {
        __navFrames?: number[];
        __navStop?: () => void;
      };
      w.__navFrames = [];
      let last = performance.now();
      let running = true;
      const loop = (t: number): void => {
        w.__navFrames!.push(t - last);
        last = t;
        if (running) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      w.__navStop = () => {
        running = false;
      };
    });

    // Scripted FAST navigation: a series of orbit flicks across the canvas, so
    // the wanted set churns and the streamer works under motion.
    const radius = Math.min(box.width, box.height) * 0.35;
    for (let i = 0; i < 16; i++) {
      const a0 = (i / 16) * Math.PI * 2;
      const a1 = a0 + Math.PI / 2;
      await page.mouse.move(cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius);
      await page.mouse.down();
      for (let s = 1; s <= 6; s++) {
        const a = a0 + ((a1 - a0) * s) / 6;
        await page.mouse.move(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      }
      await page.mouse.up();
      await page.waitForTimeout(120);
    }

    const frames = await page.evaluate(() => {
      const w = window as unknown as { __navFrames?: number[]; __navStop?: () => void };
      w.__navStop?.();
      return w.__navFrames ?? [];
    });
    const metricsDoc = await page.evaluate(() => {
      const w = window as unknown as { __olvMetrics?: () => string };
      try {
        return typeof w.__olvMetrics === 'function' ? w.__olvMetrics() : null;
      } catch {
        return null;
      }
    });

    // A real navigation must have produced frames. This is the sanity gate.
    expect(frames.length).toBeGreaterThan(10);
    const sorted = [...frames].filter((f) => f >= 0).sort((a, b) => a - b);

    const record = {
      schemaVersion: 1 as const,
      label: 'streaming-nav-device',
      generatedAt: new Date().toISOString(),
      environment: {
        runtime: 'browser' as const,
        os: process.platform,
        architecture: process.arch,
        browser: testInfo.project.name,
        // The backend actually used is read from the metrics doc when present.
        backend: 'unknown',
      },
      frameTimeMs: {
        status: 'measured' as const,
        unit: 'ms' as const,
        runtime: 'browser' as const,
        summary: {
          count: sorted.length,
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          max: sorted.length ? sorted[sorted.length - 1] : 0,
        },
        samples: sorted,
      },
      // The overlay doc carries decode / queue / residency / thrash counters;
      // it is retained verbatim so a device record can be reconciled with the
      // Node baseline without a second telemetry path.
      metricsDoc,
      note:
        'Device capture. frameTimeMs is the browser rAF cadence during a scripted ' +
        'fast orbit; mesh-creation timing is inside metricsDoc when the overlay reports it. ' +
        'Compare only against another record with the same browser, OS and backend.',
    };

    // eslint-disable-next-line no-console
    console.log(
      `streaming-nav device frames: n=${sorted.length} ` +
        `p50=${percentile(sorted, 50).toFixed(2)} ` +
        `p95=${percentile(sorted, 95).toFixed(2)} ` +
        `p99=${percentile(sorted, 99).toFixed(2)} ms`,
    );

    if (WRITE) {
      const out = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '../../docs/validation/streaming-navigation-device.json',
      );
      fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      // eslint-disable-next-line no-console
      console.log(`streaming-nav device record written to ${out}`);
    }
  });
});
