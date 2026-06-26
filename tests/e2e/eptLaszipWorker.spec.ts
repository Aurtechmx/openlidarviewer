import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * EPT laszip decode-worker browser round-trip.
 *
 * The unit suite covers the decode core, the client protocol (fake worker), and
 * the decoder dispatch — but none of them run a REAL `Worker`. This spec closes
 * that gap: in a live chromium it drives the production path end-to-end via the
 * `?test=1` seam — lazy worker-client chunk load, `new Worker(new URL(...))` URL
 * resolution (the exact seam the live source-transform can scramble into a 404),
 * laz-perf WASM instantiation inside the worker, decode of a complete LAZ tile,
 * and the zero-copy transfer of the decoded arrays back to the main thread.
 *
 * The input is the same `tests/fixtures/tiny.laz` the decode-core unit test
 * uses (12 points), so a correct off-thread decode must return exactly 12 —
 * proving the worker produced the same result as the in-process path.
 */

const TINY_LAZ = readFileSync(new URL('../fixtures/tiny.laz', import.meta.url));

test.describe('EPT laszip decode worker (browser round-trip)', () => {
  test('decodes a real LAZ tile off the main thread and returns the right count', async ({
    page,
  }) => {
    // Catch any "failed to fetch dynamically imported module" / worker-load
    // error — the runtime symptom of a scrambled worker URL or a dropped chunk.
    const moduleErrors: string[] = [];
    const note = (s: string): void => {
      if (/dynamically imported module|importing a module script|worker/i.test(s)) {
        moduleErrors.push(s);
      }
    };
    page.on('console', (msg) => note(msg.text()));
    page.on('pageerror', (err) => note(err.message));

    await page.goto('/?test=1');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    // The test API mounts after the viewer chunk resolves.
    await page.waitForFunction(
      () =>
        !!(window as unknown as { __OLV_TEST_API__?: { decodeEptLaszipTileInWorker?: unknown } })
          .__OLV_TEST_API__?.decodeEptLaszipTileInWorker,
    );

    // Pass the 663-byte fixture as a plain number[] (survives evaluate
    // serialisation), reconstruct the ArrayBuffer in the page, hand it to the
    // worker through the production client.
    const tileBytes = Array.from(TINY_LAZ);
    const pointCount = await page.evaluate(async (bytes) => {
      const u8 = Uint8Array.from(bytes as number[]);
      const api = (
        window as unknown as {
          __OLV_TEST_API__: { decodeEptLaszipTileInWorker: (t: ArrayBuffer) => Promise<number> };
        }
      ).__OLV_TEST_API__;
      return api.decodeEptLaszipTileInWorker(u8.buffer);
    }, tileBytes);

    // tiny.laz carries 12 points — the off-thread worker must agree with the
    // in-process decoder the unit test pins to the same number.
    expect(pointCount).toBe(12);
    expect(
      moduleErrors,
      `worker / module-load errors in the browser: ${moduleErrors.join('; ')}`,
    ).toEqual([]);
  });
});
