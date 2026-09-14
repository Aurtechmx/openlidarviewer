import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LadderRung } from '../helpers/lazLadder';

/**
 * localOpenDevice.spec.ts: the browser half of the local LAZ open measurement.
 *
 * The two Node legs (`tests/benchmark/localOpenBaseline.test.ts`,
 * `localOpenPooled.test.ts`) time the single reader and the worker pool up to
 * decoded points. Only a browser can time the open the user gets: a real module
 * Worker per pool slot, fetched and compiled on each start, and the load's own
 * telemetry from drop to first render. This spec opens each ladder rung through
 * the hidden file input, once per mode, and reads the `?debug=1` load telemetry
 * the app prints.
 *
 * Modes: `?decodePool=off` pins the single reader for every size, and
 * `?decodePool=on` engages the pool at the device policy's size. The number of
 * chunk workers the page spawned is counted from Playwright's worker events, so
 * "the pool engaged" is observed rather than assumed. Each open is a fresh page,
 * so every pool is cold; the first open of each mode also pays the worker
 * script's network fetch, which later opens take from the browser cache. Both
 * the first and the best of N are printed.
 *
 * HOW TO RUN. PDAL on the path, then:
 *
 *     npm run benchmark:local-open-device
 *
 * Skips cleanly without `LAZ_DECODE_BENCH=1` or PDAL.
 *
 * The ladder helper writes its LAS through the app's writer, which stamps the
 * build identity Vite defines at build time. Playwright's runtime has no such
 * define, so the spec supplies a placeholder before loading the helper; it
 * only names the generating software inside a temporary file.
 */

const ENABLED = process.env.LAZ_DECODE_BENCH === '1';
const RUNS = 3;

type Ladder = typeof import('../helpers/lazLadder');
async function loadLadder(): Promise<Ladder> {
  const g = globalThis as unknown as Record<string, unknown>;
  g.__APP_VERSION__ ??= '0.0.0-bench';
  g.__BUILD_IDENTITY__ ??= {
    version: '0.0.0-bench',
    commit: 'unknown',
    dirty: false,
    builtAt: new Date(0).toISOString(),
    node: process.version,
    channel: 'dev',
  };
  return import('../helpers/lazLadder');
}

interface OpenTiming {
  readonly decodeMs: number;
  readonly totalMs: number;
  readonly workers: number;
  readonly chunkWorkers: number;
}

function row(text: string, label: string): number {
  const m = new RegExp(`^\\s*${label}\\s+([\\d.]+) ms`, 'm').exec(text);
  return m ? Number(m[1]) : Number.NaN;
}

/** Open `file` on a fresh page at `url` and read the load telemetry block. */
async function openOnce(page: Page, url: string, file: string): Promise<OpenTiming> {
  const workerUrls: string[] = [];
  page.on('worker', (w) => workerUrls.push(w.url()));
  await page.goto(url);
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  const telemetry = page.waitForEvent('console', {
    predicate: (msg) => msg.text().includes('load telemetry'),
    timeout: 600_000,
  });
  await page.locator('.olv-file-input').first().setInputFiles(file);
  const text = (await telemetry).text();
  return {
    decodeMs: row(text, 'decode'),
    totalMs: row(text, 'total \\(wall\\)'),
    workers: workerUrls.length,
    chunkWorkers: workerUrls.filter((u) => /lazChunkWorker/i.test(u)).length,
  };
}

const ms = (v: number): string => (Number.isFinite(v) ? v.toFixed(0) : 'n/a').padStart(6);

test.describe('local LAZ open on device: single reader against the worker pool', () => {
  test.skip(!ENABLED, 'LAZ_DECODE_BENCH=1 not set');
  test.setTimeout(3_600_000);

  let dir = '';
  let ladder: Ladder | null = null;
  let SIZES_M: number[] = [];
  const rungs: LadderRung[] = [];
  test.beforeAll(async () => {
    if (!ENABLED) return;
    ladder = await loadLadder();
    const pdal = ladder.pdalPath();
    test.skip(pdal === null, 'PDAL not found on the path');
    SIZES_M = ladder.benchSizesM('1,2,5,10');
    dir = mkdtempSync(join(tmpdir(), 'olv-local-open-device-'));
    for (const m of SIZES_M) rungs.push(ladder.writeLadderRung(dir, m, pdal!));
  });
  test.afterAll(() => {
    for (const r of rungs) ladder?.removeLadderRung(r);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('times each rung in both modes and reports first and best', async ({ context }) => {
    const modes: Array<{ name: string; url: string }> = [
      { name: 'single', url: '/?debug=1&decodePool=off' },
      { name: 'pooled', url: '/?debug=1&decodePool=on' },
    ];
    // eslint-disable-next-line no-console
    console.log(
      `\nLocal LAZ open on device: sizes=${SIZES_M.join(',')}M, ${RUNS} opens per mode, each on a fresh page`,
    );
    // eslint-disable-next-line no-console
    console.log(
      '  size | mode   | decode first | decode best | wall first | wall best | workers (chunk) | runs',
    );

    for (const [i, rung] of rungs.entries()) {
      const m = SIZES_M[i];
      const results: Record<string, OpenTiming[]> = {};
      for (const mode of modes) {
        results[mode.name] = [];
        for (let r = 0; r < RUNS; r++) {
          const page = await context.newPage();
          try {
            const t = await openOnce(page, mode.url, rung.lazPath);
            expect(Number.isFinite(t.decodeMs), `${m}M ${mode.name} decode row`).toBe(true);
            results[mode.name].push(t);
          } finally {
            await page.close();
          }
        }
        const runs = results[mode.name];
        const decodes = runs.map((t) => t.decodeMs);
        const walls = runs.map((t) => t.totalMs);
        // eslint-disable-next-line no-console
        console.log(
          `  ${m.toString().padStart(3)}M | ${mode.name.padEnd(6)} | ${ms(decodes[0])} | ${ms(Math.min(...decodes))} | ` +
            `${ms(walls[0])} | ${ms(Math.min(...walls))} | ${runs[0].workers} (${runs[0].chunkWorkers}) | ` +
            `decode[${decodes.map((x) => x.toFixed(0)).join(',')}] wall[${walls.map((x) => x.toFixed(0)).join(',')}]`,
        );
      }
      // The pool must have been observed engaging, or the pooled column is not a pooled number.
      expect(results.pooled[0].chunkWorkers, `${m}M pooled run spawned chunk workers`).toBeGreaterThan(0);
      expect(results.single[0].chunkWorkers, `${m}M single run spawned no chunk worker`).toBe(0);
    }
  });
});
