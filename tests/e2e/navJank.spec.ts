/**
 * navJank.spec.ts: the heavy-navigation benchmark runner. Tagged `@gpu`, so it
 * runs only in the `gpu` project, never in the deterministic lane.
 *
 * For each scripted trajectory: one cold run (the first load in a fresh
 * browser context) and OLV_NAV_RUNS warm runs (default 5) in the same context,
 * each on a fresh page load. A run opens the dataset through the file input,
 * waits for the committed cloud's first frame (the `?benchmark` load report),
 * restarts the navigation probe, plays the trajectory on the frame clock and
 * keeps the probe summary. The fixed-step replay mode is the replay check's
 * (navDriver.spec.ts), not this measurement's.
 *
 * Dataset: OLV-DS-090, the registered Jemez River Basin snow-off tile
 * (OpenTopography, CC-BY-4.0, 10,789,680 points). Point OLV_NAV_DATASET at a
 * local copy of `ot_356000_3972000_1.laz`; the spec skips without it.
 *
 *   OLV_NAV_DATASET=/path/to/ot_356000_3972000_1.laz OLV_NAV_MACHINE=mbp-local \
 *     npx playwright test tests/e2e/navJank.spec.ts --project=gpu --headed
 *
 * Each trajectory's result is kept under the OS temp directory per commit and
 * machine, and after every test the kept trajectories are merged into
 * validation/performance/nav-jank/<date>-<sha>-<machine>.json. So a session can
 * be run one trajectory at a time (`-g orbit`) and still yield one file. Read
 * it with `node scripts/nav-jank-report.mjs <file>`.
 *
 * Nothing about timing is asserted: this measures.
 */
import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNavJankRecord, validateJsonSchema, type NavJankEnv, type NavJankRun } from '../../src/perf/navJankRecord';
import type { NavProbeSummary } from '../../src/perf/navProbe';
import { buildNavJankResults, mergeNavJankResults, resultFileName, type NavJankResults } from '../../scripts/lib/navJankResults.mjs';

const TRAJECTORIES = ['orbit', 'flythrough', 'zoomShock', 'scrub', 'stopInspect'] as const;
const DATASET = process.env.OLV_NAV_DATASET ?? '';
const RUNS = Math.max(1, Number(process.env.OLV_NAV_RUNS ?? 5));
const MACHINE = process.env.OLV_NAV_MACHINE ?? 'local';
const DATASET_ID = 'OLV-DS-090-JEMEZ-SNOWOFF-2010-FOREST';
/** Upper bound on one load (file input to the committed cloud's first frame). */
const LOAD_TIMEOUT_MS = 240_000;
/** Upper bound on one trajectory; past it the run keeps what the probe saw. */
const DRIVE_TIMEOUT_MS = 180_000;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'validation/performance/nav-jank.schema.json'), 'utf8'));
const OUT_DIR = join(ROOT, 'validation/performance/nav-jank');

function registeredSha(): string | null {
  const reg = readFileSync(join(ROOT, 'validation/datasets/dataset-register.yaml'), 'utf8');
  const at = reg.indexOf(`datasetId: ${DATASET_ID}`);
  if (at < 0) return null;
  return /sourceSha256:\s*([0-9a-f]{64})/.exec(reg.slice(at, at + 2000))?.[1] ?? null;
}

/** SHA-256 of the dataset, cached by path, size and mtime (hashing 49 MB per run is waste). */
async function datasetSha(path: string): Promise<string> {
  const st = statSync(path);
  const cacheFile = join(tmpdir(), 'olv-nav-dataset-sha.json');
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  let cache: Record<string, string> = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  } catch {
    // No cache yet.
  }
  if (cache[key]) return cache[key];
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
  cache[key] = hash.digest('hex');
  writeFileSync(cacheFile, JSON.stringify(cache));
  return cache[key];
}

interface LoadTiming { cache: 'cold' | 'warm'; timeToFirstRenderMs: number | null; pointsRendered: string | null; wallMs: number }

interface DriveOut {
  trajectoryDigest: string;
  settled: boolean;
  unsettledAt: string | null;
  frames: number;
  timedOut: boolean;
  summary: NavProbeSummary;
}

/** Live long-task attribution, for a stall report. */
async function probeSnapshot(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const p = (window as unknown as { __olvNavProbe?: { summary(): NavProbeSummary } }).__olvNavProbe;
      if (!p) return 'no probe';
      const s = p.summary();
      return JSON.stringify({ frames: s.frames, longestStarvationMs: s.longestStarvationMs, longTasks: s.longTasks });
    })
    .catch((e: Error) => `probe unreadable: ${e.message}`);
}

/** Open the dataset through the file input and wait for the committed cloud's first frame. */
async function load(page: Page, cache: 'cold' | 'warm'): Promise<LoadTiming> {
  await page.goto('/?benchmark=nav');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  const report = page.waitForEvent('console', {
    predicate: (m) => m.text().includes('OpenLiDARViewer — benchmark'),
    timeout: LOAD_TIMEOUT_MS,
  });
  const t0 = Date.now();
  await page.locator('.olv-file-input').first().setInputFiles(DATASET);
  let text: string;
  try {
    text = (await report).text();
  } catch (e) {
    throw new Error(`load did not finish in ${LOAD_TIMEOUT_MS} ms; probe: ${await probeSnapshot(page)}`, { cause: e });
  }
  const wallMs = Date.now() - t0;
  await expect(page.locator('.olv-empty')).toBeHidden();
  await page.waitForFunction(() => {
    const w = window as unknown as { __olvNavDriver?: unknown; __olvNavProbe?: unknown };
    return Boolean(w.__olvNavDriver && w.__olvNavProbe);
  });
  const ttfr = /time to first render\s+([\d.]+) ms/.exec(text)?.[1];
  const points = /points rendered\s+(.+)/.exec(text)?.[1]?.trim() ?? null;
  return { cache, timeToFirstRenderMs: ttfr ? Number(ttfr) : null, pointsRendered: points, wallMs };
}

async function drive(page: Page, name: string): Promise<DriveOut> {
  // Let the first frames after the load pass before measuring.
  await page.waitForTimeout(1_000);
  return page.evaluate(
    async ({ name, timeoutMs }) => {
      type Result = { trajectoryDigest: string; settled: boolean; unsettledAt: string | null; frames: number };
      const w = window as unknown as {
        __olvNavProbe: { stop(n?: string): NavProbeSummary; start(): void };
        __olvNavDriver: { run(n: string, o: { fixedStep: boolean }): Promise<Result> };
      };
      w.__olvNavProbe.stop();
      w.__olvNavProbe.start();
      let timer = 0;
      const timeout = new Promise<null>((r) => {
        timer = window.setTimeout(() => r(null), timeoutMs);
      });
      const res = await Promise.race([w.__olvNavDriver.run(name, { fixedStep: false }), timeout]);
      clearTimeout(timer);
      const summary = w.__olvNavProbe.stop(name);
      if (!res) return { trajectoryDigest: 'timeout', settled: false, unsettledAt: 'input', frames: 0, timedOut: true, summary };
      return { ...res, timedOut: false, summary };
    },
    { name, timeoutMs: DRIVE_TIMEOUT_MS },
  );
}

async function environment(page: Page, context: BrowserContext, info: TestInfo): Promise<Omit<NavJankEnv, 'trajectoryDigest' | 'cache'>> {
  const probe = await page.evaluate(async () => {
    const gaps: number[] = [];
    let last = await new Promise<number>((r) => requestAnimationFrame(r));
    for (let i = 0; i < 90; i++) {
      const t = await new Promise<number>((r) => requestAnimationFrame(r));
      gaps.push(t - last);
      last = t;
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1];
    let gpu = '';
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> } };
    try {
      const adapter = await nav.gpu?.requestAdapter();
      const i = adapter?.info;
      if (i) gpu = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');
    } catch {
      // No WebGPU adapter.
    }
    let gl = '';
    const ctx = document.createElement('canvas').getContext('webgl2');
    if (ctx) {
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      gl = String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER));
    }
    return {
      hz: median > 0 ? Math.round(1000 / median) : 0,
      dpr: devicePixelRatio,
      backend: document.querySelector('.olv-backend-text')?.textContent?.trim() || 'unknown',
      gpu,
      gl,
    };
  });
  const headless = info.project.use.headless !== false;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const browser = context.browser();
  return {
    commit,
    browser: `${browser?.browserType().name() ?? 'unknown'} ${browser?.version() ?? ''}`.trim(),
    os: `${process.platform} ${release()} ${process.arch}`,
    renderer: `${probe.backend} / webgpu: ${probe.gpu || 'none'} / webgl2: ${probe.gl || 'none'}`,
    dpr: probe.dpr,
    refreshEstimateHz: probe.hz,
    datasetSha256: await datasetSha(DATASET),
    flags: ['benchmark=nav', 'frame-clock', headless ? 'headless' : 'headed'],
  };
}

function partialDir(commit: string): string {
  const dir = join(tmpdir(), 'olv-nav-jank', `${commit.slice(0, 12)}-${MACHINE}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Merge every kept trajectory of this commit and machine into the committed result file. */
function writeMerged(commit: string): string {
  const dir = partialDir(commit);
  const parts = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as NavJankResults);
  const order = (n: string) => TRAJECTORIES.indexOf(n as (typeof TRAJECTORIES)[number]);
  parts.sort((a, b) => order(Object.keys(a.trajectories)[0]) - order(Object.keys(b.trajectories)[0]));
  const merged = mergeNavJankResults(parts);
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, resultFileName(new Date(merged.generatedAt), commit, MACHINE));
  writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  return file;
}

test.describe('@gpu navigation jank benchmark', () => {
  test.skip(!DATASET || !existsSync(DATASET), 'set OLV_NAV_DATASET to a local copy of OLV-DS-090 (ot_356000_3972000_1.laz)');
  test.describe.configure({ mode: 'serial' });

  for (const name of TRAJECTORIES) {
    test(`${name}: 1 cold + ${RUNS} warm runs`, async ({ browser }, info) => {
      test.setTimeout((RUNS + 1) * (LOAD_TIMEOUT_MS + DRIVE_TIMEOUT_MS));
      const use = info.project.use;
      const context = await browser.newContext({
        baseURL: use.baseURL,
        storageState: use.storageState,
        viewport: use.viewport,
        deviceScaleFactor: use.deviceScaleFactor,
        userAgent: use.userAgent,
      });
      const notes: string[] = [];
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(60_000);
        const runs: { cache: 'cold' | 'warm'; load: LoadTiming; out: DriveOut }[] = [];
        let env: Omit<NavJankEnv, 'trajectoryDigest' | 'cache'> | null = null;
        for (let i = 0; i <= RUNS; i++) {
          const cache = i === 0 ? 'cold' : 'warm';
          const timing = await load(page, cache);
          env ??= await environment(page, context, info);
          const out = await drive(page, name);
          if (out.timedOut) notes.push(`${name} run ${i} (${cache}): trajectory did not finish in ${DRIVE_TIMEOUT_MS} ms`);
          else if (!out.settled) notes.push(`${name} run ${i} (${cache}): camera did not settle (${out.unsettledAt})`);
          console.log(
            `[nav-jank] ${name} ${cache} #${i}: load ${timing.wallMs} ms, frames ${out.summary.frames}, ` +
              `p95 ${out.summary.frameMs.p95.toFixed(1)} ms, starvation ${out.summary.longestStarvationMs.toFixed(0)} ms, ` +
              `long tasks ${out.summary.longTasks.count}`,
          );
          runs.push({ cache, load: timing, out });
        }
        if (!env) throw new Error('no environment');
        const digests = new Set(runs.filter((r) => !r.out.timedOut).map((r) => r.out.trajectoryDigest));
        expect(digests.size).toBe(1);
        const trajectoryDigest = [...digests][0];
        const toRuns = (rs: typeof runs): NavJankRun[] => rs.map((r, k) => ({ name: `${name}-${r.cache}-${k}`, summary: r.out.summary }));
        const cold = buildNavJankRecord({ ...env, trajectoryDigest, cache: 'cold' }, toRuns(runs.slice(0, 1)));
        const warm = buildNavJankRecord({ ...env, trajectoryDigest, cache: 'warm' }, toRuns(runs.slice(1)));
        for (const rec of [cold, warm]) expect(validateJsonSchema(SCHEMA, rec)).toEqual([]);

        const sha = env.datasetSha256;
        const registered = registeredSha();
        if (registered && registered !== sha) notes.push(`dataset SHA-256 ${sha} differs from the register's ${registered}`);
        notes.push('scientific result digests not collected: the trajectories run no analysis');
        const result = buildNavJankResults({
          generatedAt: new Date().toISOString(),
          machine: MACHINE,
          dataset: { id: DATASET_ID, licence: 'CC-BY-4.0', file: 'ot_356000_3972000_1.laz', sha256: sha, bytes: statSync(DATASET).size, registeredSha256: registered },
          trajectories: { [name]: { cold, warm, loads: runs.map((r) => r.load) } },
          notes,
        });
        writeFileSync(join(partialDir(env.commit), `${name}.json`), JSON.stringify(result));
        const file = writeMerged(env.commit);
        console.log(`[nav-jank] wrote ${file}`);
      } finally {
        await context.close();
      }
    });
  }
});
