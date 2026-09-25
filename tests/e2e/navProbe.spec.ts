/**
 * navProbe.spec.ts: `?benchmark=nav` installs the navigation frame probe.
 *
 * Opens a small scan, orbits with the mouse, and reads the probe back through
 * `window.__olvNavProbe`. Checks only that frames were recorded and that the
 * record it builds is valid against validation/performance/nav-jank.schema.json;
 * timings depend on the runner and are not asserted.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateJsonSchema } from '../../src/perf/navJankRecord';

const FIXTURE = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));
const SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../validation/performance/nav-jank.schema.json', import.meta.url)), 'utf8'),
);

test('nav probe records an orbit and builds a valid record', async ({ page }) => {
  test.slow();
  await page.goto('/?benchmark=nav');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await page.locator('.olv-file-input').first().setInputFiles(FIXTURE);
  await expect(page.locator('.olv-project-card')).toHaveClass(/olv-visible/, { timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as { __olvNavProbe?: unknown }).__olvNavProbe));

  await page.evaluate(() => {
    const p = (window as unknown as { __olvNavProbe: { stop(): void; start(): void } }).__olvNavProbe;
    p.stop();
    p.start();
  });
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let k = 1; k <= 20; k++) await page.mouse.move(cx + k * 8, cy + k * 2, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const record = await page.evaluate(() => {
    const p = (window as unknown as { __olvNavProbe: { stop(n: string): unknown; record(env: unknown): unknown } }).__olvNavProbe;
    p.stop('orbit');
    return p.record({
      commit: 'unknown', browser: navigator.userAgent, os: navigator.platform || 'unknown', renderer: 'unknown',
      dpr: devicePixelRatio, refreshEstimateHz: 0, datasetSha256: 'unknown', trajectoryDigest: 'e2e-orbit',
      flags: ['benchmark=nav'], cache: 'cold',
    });
  }) as { runs: { summary: { frames: number } }[] };

  expect(record.runs[0].summary.frames).toBeGreaterThan(0);
  expect(validateJsonSchema(SCHEMA, record)).toEqual([]);
});
