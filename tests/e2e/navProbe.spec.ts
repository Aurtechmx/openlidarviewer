/**
 * navProbe.spec.ts: `?benchmark=nav` installs the navigation frame probe.
 *
 * Opens a small scan, orbits with the mouse, and reads the probe back through
 * `window.__olvNavProbe`. Checks only that frames were recorded and that the
 * record it builds is valid against validation/performance/nav-jank.schema.json;
 * timings depend on the runner and are not asserted.
 *
 * The scan is `tiny.ply`: on the runner's software renderer a drag over the
 * multichunk LAZ fixture outlasts the test timeout, probe or no probe.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateJsonSchema } from '../../src/perf/navJankRecord';
import { dropTinyPly } from './helpers';

const SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../validation/performance/nav-jank.schema.json', import.meta.url)), 'utf8'),
);

interface Handle {
  start(): void;
  stop(name?: string): unknown;
  record(env: unknown): unknown;
}

test('nav probe records an orbit and builds a valid record', async ({ page }) => {
  await page.goto('/?benchmark=nav');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForFunction(() => Boolean((window as { __olvNavProbe?: unknown }).__olvNavProbe));

  // Restart so the run covers the orbit only, not the load.
  await page.evaluate(() => {
    const p = (window as unknown as { __olvNavProbe: Handle }).__olvNavProbe;
    p.stop();
    p.start();
  });
  const box = await page.locator('.olv-canvas').boundingBox();
  if (!box) throw new Error('no canvas box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(cx + k * 14, cy + k * 4);
  await page.mouse.up();
  await page.waitForTimeout(400);

  const record = await page.evaluate(() => {
    const p = (window as unknown as { __olvNavProbe: Handle }).__olvNavProbe;
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
