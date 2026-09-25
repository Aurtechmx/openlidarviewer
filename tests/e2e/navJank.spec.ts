/**
 * navJank.spec.ts: the heavy-navigation benchmark runner. Tagged `@bench`, so it
 * runs only in the `bench` project (`npm run test:e2e:bench`, headed), never in
 * the deterministic lane or the advisory gpu job.
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
 *     npx playwright test tests/e2e/navJank.spec.ts --project=bench --headed
 *
 * Each trajectory's result is kept under the OS temp directory per commit and
 * machine, and after every test the kept trajectories are merged into
 * validation/performance/nav-jank/<date>-<sha>-<machine>.json. So a session can
 * be run one trajectory at a time (`-g orbit`) and still yield one file. Read
 * it with `node scripts/nav-jank-report.mjs <file>`.
 *
 * Chromium runs with the flags in {@link ANTI_THROTTLE_ARGS} (set for this file
 * only, not the bench project), so an occluded
 * or unfocused headed window is not throttled; the environment's flags say so.
 * Each run records `document.visibilityState` and `document.hasFocus()` at its
 * start and end, and a run during which the page was hidden is invalid: it is
 * listed in the notes and left out of the records.
 *
 * Diagnostics (not for a baseline): OLV_NAV_THROTTLE_FLAGS=off launches without
 * those flags, and OLV_NAV_WINDOW=covered|minimized covers the window with a
 * second browser window or minimises it before each trajectory.
 *
 * Nothing about timing is asserted: this measures.
 */
import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, createReadStream, existsSync, openSync, readSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNavJankRecord, validateJsonSchema, type NavJankEnv, type NavJankRun } from '../../src/perf/navJankRecord';
import type { NavProbeSummary } from '../../src/perf/navProbe';
import { buildNavJankResults, mergeNavJankResults, resultFileName, type NavJankResults } from '../../scripts/lib/navJankResults.mjs';

const TRAJECTORIES = ['orbit', 'flythrough', 'zoomShock', 'scrub', 'stopInspect'] as const;
const DATASET = process.env.OLV_NAV_DATASET ?? '';
const RUNS = Math.max(1, Number(process.env.OLV_NAV_RUNS ?? 5));
const MACHINE = process.env.OLV_NAV_MACHINE ?? 'local';
const WINDOW_MODE = process.env.OLV_NAV_WINDOW ?? 'normal';
/** Chromium switches that stop it throttling an occluded, unfocused or background window. */
const ANTI_THROTTLE_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];
const THROTTLE_FLAGS_ON = process.env.OLV_NAV_THROTTLE_FLAGS !== 'off';
/** A frame-clock delta at least this long counts as a gap in the run's timeline. */
const GAP_MS = 200;
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
/** Working files live under the repository's ignored playwright/.cache/ (kept between runs), not a shared temp directory. */
const WORK_DIR = join(process.cwd(), 'playwright', '.cache', 'nav-jank');

async function datasetSha(path: string): Promise<string> {
  const st = statSync(path);
  mkdirSync(WORK_DIR, { recursive: true });
  const cacheFile = join(WORK_DIR, 'dataset-sha.json');
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

/** Bounds diagonal from the LAS/LAZ public header (max/min X, Y, Z doubles at byte 179), for the driver's rest tolerance. */
function lasDiagonal(path: string): number {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(48);
    readSync(fd, b, 0, 48, 179);
    const [maxX, minX, maxY, minY, maxZ, minZ] = [0, 8, 16, 24, 32, 40].map((o) => b.readDoubleLE(o));
    return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  } finally {
    closeSync(fd);
  }
}

interface LoadTiming { cache: 'cold' | 'warm'; timeToFirstRenderMs: number | null; pointsRendered: string | null; wallMs: number }

interface RunMeta {
  visibility: { start: string; end: string; hiddenDuring: boolean };
  focus: { start: boolean; end: boolean };
  /** performance.now() of the probe start and of the first and last dispatched input. */
  probeStartT: number;
  firstInputT: number | null;
  lastInputT: number | null;
  endT: number;
  /** Frame-clock deltas of at least GAP_MS: [ms after first input, delta ms]. */
  gaps: [number, number][];
  gapsDuringInput: number;
  gapsAfterInput: number;
  /** Quality transitions: [ms after first input, kind, from, to]. */
  quality: [number, string, number | string, number | string][];
  /**
   * Frames from 500 ms before the last input on (at most 200): [ms after first
   * input, drawn, EDL drawn, idle wake 0/1 heartbeat/2 wake, phase code].
   * Read from the probe's columns when the build exposes them, else empty.
   */
  tail: [number, number, number, number, number][];
}

interface DriveOut {
  trajectoryDigest: string;
  settled: boolean;
  unsettledAt: string | null;
  frames: number;
  timedOut: boolean;
  summary: NavProbeSummary;
  meta: RunMeta;
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

async function drive(page: Page, name: string, sceneDiagonal: number): Promise<DriveOut> {
  // Let the first frames after the load pass before measuring.
  await page.waitForTimeout(1_000);
  return page.evaluate(
    async ({ name, timeoutMs, gapMs, sceneDiagonal }) => {
      type Result = { trajectoryDigest: string; settled: boolean; unsettledAt: string | null; frames: number };
      const w = window as unknown as {
        __olvNavProbe: { stop(n?: string): NavProbeSummary; start(): void };
        __olvNavDriver: { run(n: string, o: { fixedStep: boolean; sceneDiagonal: number }): Promise<Result> };
        __olvNavSink?: { frameMs(ms: number): void };
      };
      const visStart = document.visibilityState;
      const focusStart = document.hasFocus();
      let hiddenDuring = visStart === 'hidden';
      const onVis = (): void => {
        if (document.visibilityState === 'hidden') hiddenDuring = true;
      };
      document.addEventListener('visibilitychange', onVis);
      const inputs: number[] = [];
      const onInput = (e: Event): void => {
        inputs.push(e.timeStamp);
      };
      const types = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown'];
      for (const t of types) window.addEventListener(t, onInput, { capture: true, passive: true });

      w.__olvNavProbe.stop();
      const probeStartT = performance.now();
      w.__olvNavProbe.start();
      // Wrap the installed sink's frame-time hook to keep a timeline of long deltas.
      const deltas: [number, number][] = [];
      const sink = w.__olvNavSink;
      const orig = sink?.frameMs;
      if (sink && orig) {
        sink.frameMs = (ms: number) => {
          if (ms >= gapMs) deltas.push([performance.now(), ms]);
          orig.call(sink, ms);
        };
      }
      let timer = 0;
      const timeout = new Promise<null>((r) => {
        timer = window.setTimeout(() => r(null), timeoutMs);
      });
      let res: Result | null;
      try {
        res = await Promise.race([w.__olvNavDriver.run(name, { fixedStep: false, sceneDiagonal }), timeout]);
      } finally {
        clearTimeout(timer);
        if (sink && orig) sink.frameMs = orig;
        for (const t of types) window.removeEventListener(t, onInput, { capture: true });
        document.removeEventListener('visibilitychange', onVis);
      }
      const summary = w.__olvNavProbe.stop(name);
      const cols = sink as unknown as {
        _f?: { count: number; at(k: number): number };
        _tEnd?: Float64Array; _drawn?: Uint8Array; _edl?: Uint8Array; _wake?: Uint8Array; _phase?: Uint8Array;
      } | undefined;
      const endT = performance.now();
      const first = inputs.length ? Math.min(...inputs) : null;
      const last = inputs.length ? Math.max(...inputs) : null;
      const rel = (t: number): number => Math.round((t - (first ?? probeStartT)) * 10) / 10;
      const meta = {
        visibility: { start: visStart, end: document.visibilityState, hiddenDuring: hiddenDuring || document.visibilityState === 'hidden' },
        focus: { start: focusStart, end: document.hasFocus() },
        probeStartT,
        firstInputT: first,
        lastInputT: last,
        endT,
        gaps: deltas.map(([t, ms]) => [rel(t), Math.round(ms * 10) / 10] as [number, number]),
        gapsDuringInput: deltas.filter(([t]) => first !== null && last !== null && t >= first && t <= last).length,
        gapsAfterInput: deltas.filter(([t]) => last !== null && t > last).length,
        quality: summary.quality.events.map((e) => [rel(e.t), e.kind, e.from, e.to] as [number, string, number | string, number | string]),
        tail: [] as [number, number, number, number, number][],
      };
      if (cols?._f && cols._tEnd && cols._drawn && cols._edl && cols._wake && cols._phase && last !== null) {
        for (let k = 0; k < cols._f.count && meta.tail.length < 200; k++) {
          const i = cols._f.at(k);
          if (cols._tEnd[i] < last - 500) continue;
          meta.tail.push([rel(cols._tEnd[i]), cols._drawn[i], cols._edl[i], cols._wake[i], cols._phase[i]]);
        }
      }
      if (!res) return { trajectoryDigest: 'timeout', settled: false, unsettledAt: 'input', frames: 0, timedOut: true, summary, meta };
      return { ...res, timedOut: false, summary, meta };
    },
    { name, timeoutMs: DRIVE_TIMEOUT_MS, gapMs: GAP_MS, sceneDiagonal },
  );
}

/** Diagnostics only: cover the page's window with a second window, or minimise it. */
async function applyWindowMode(page: Page, context: BrowserContext): Promise<BrowserContext | null> {
  if (WINDOW_MODE === 'normal') return null;
  const cdp = await context.newCDPSession(page);
  const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
  if (WINDOW_MODE === 'minimized') {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    return null;
  }
  const browser = context.browser();
  if (!browser) throw new Error('no browser');
  const cover = await browser.newContext();
  const coverPage = await cover.newPage();
  await coverPage.setContent('<body style="background:#444"></body>');
  const c = await cover.newCDPSession(coverPage);
  const w2 = await c.send('Browser.getWindowForTarget');
  await c.send('Browser.setWindowBounds', {
    windowId: w2.windowId,
    bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
  });
  await coverPage.bringToFront();
  return cover;
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
    flags: [
      'benchmark=nav',
      'frame-clock',
      headless ? 'headless' : 'headed',
      ...(THROTTLE_FLAGS_ON ? ANTI_THROTTLE_ARGS.map((a) => a.replace(/^--/, '')) : []),
      ...(WINDOW_MODE === 'normal' ? [] : [`window=${WINDOW_MODE}`]),
    ],
  };
}

function partialDir(commit: string): string {
  const dir = join(WORK_DIR, `${commit.slice(0, 12)}-${MACHINE}`);
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

// Top level: launch options force a worker of their own, which a describe group cannot ask for.
test.use({ launchOptions: { args: THROTTLE_FLAGS_ON ? ANTI_THROTTLE_ARGS : [] } });

test.describe('@bench navigation jank benchmark', () => {
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
        const runs: { cache: 'cold' | 'warm'; load: LoadTiming; out: DriveOut; valid: boolean }[] = [];
        let env: Omit<NavJankEnv, 'trajectoryDigest' | 'cache'> | null = null;
        for (let i = 0; i <= RUNS; i++) {
          const cache = i === 0 ? 'cold' : 'warm';
          const timing = await load(page, cache);
          env ??= await environment(page, context, info);
          const cover = await applyWindowMode(page, context);
          const out = await drive(page, name, lasDiagonal(DATASET));
          await cover?.close();
          const valid = !out.meta.visibility.hiddenDuring;
          if (!valid) notes.push(`${name} run ${i} (${cache}): INVALID, the page was hidden during the run`);
          if (out.timedOut) notes.push(`${name} run ${i} (${cache}): trajectory did not finish in ${DRIVE_TIMEOUT_MS} ms`);
          else if (!out.settled) notes.push(`${name} run ${i} (${cache}): camera did not settle (${out.unsettledAt})`);
          console.log(
            `[nav-jank] ${name} ${cache} #${i}: load ${timing.wallMs} ms, frames ${out.summary.frames}, ` +
              `p95 ${out.summary.frameMs.p95.toFixed(1)} ms, starvation ${out.summary.longestStarvationMs.toFixed(0)} ms, ` +
              `p99 ${out.summary.frameMs.p99.toFixed(1)} ms, active p95/p99 ${out.summary.active.frameMs.p95.toFixed(1)}/` +
              `${out.summary.active.frameMs.p99.toFixed(1)} ms, EDL flaps ${out.summary.settle.postInputEdlFlaps}, ` +
              `to stationary ${out.summary.settle.timeToStationaryQualityMs.toFixed(0)} ms, settled ${out.settled}, long tasks ${out.summary.longTasks.count}, ` +
              `gaps>=${GAP_MS}ms ${out.meta.gaps.length} (during input ${out.meta.gapsDuringInput}, after ${out.meta.gapsAfterInput}), ` +
              `vis ${out.meta.visibility.start}->${out.meta.visibility.end}${out.meta.visibility.hiddenDuring ? ' HIDDEN' : ''}, ` +
              `focus ${out.meta.focus.start}->${out.meta.focus.end}`,
          );
          runs.push({ cache, load: timing, out, valid });
        }
        if (!env) throw new Error('no environment');
        const digests = new Set(runs.filter((r) => !r.out.timedOut).map((r) => r.out.trajectoryDigest));
        const coldRuns = runs.slice(0, 1).filter((r) => r.valid);
        const warmRuns = runs.slice(1).filter((r) => r.valid);
        expect(digests.size).toBe(1);
        const trajectoryDigest = [...digests][0];
        const toRuns = (rs: typeof runs): NavJankRun[] => rs.map((r, k) => ({ name: `${name}-${r.cache}-${k}`, summary: r.out.summary }));
        const cold = coldRuns.length ? buildNavJankRecord({ ...env, trajectoryDigest, cache: 'cold' }, toRuns(coldRuns)) : undefined;
        const warm = warmRuns.length ? buildNavJankRecord({ ...env, trajectoryDigest, cache: 'warm' }, toRuns(warmRuns)) : undefined;
        if (!cold && !warm) throw new Error(`${name}: every run was invalid (page hidden)`);
        for (const rec of [cold, warm]) if (rec) expect(validateJsonSchema(SCHEMA, rec)).toEqual([]);

        const sha = env.datasetSha256;
        const registered = registeredSha();
        if (registered && registered !== sha) notes.push(`dataset SHA-256 ${sha} differs from the register's ${registered}`);
        notes.push('scientific result digests not collected: the trajectories run no analysis');
        const result = buildNavJankResults({
          generatedAt: new Date().toISOString(),
          machine: MACHINE,
          dataset: { id: DATASET_ID, boundsDiagonal: lasDiagonal(DATASET), licence: 'CC-BY-4.0', file: 'ot_356000_3972000_1.laz', sha256: sha, bytes: statSync(DATASET).size, registeredSha256: registered },
          trajectories: {
            [name]: {
              cold,
              warm,
              loads: runs.map((r) => r.load),
              runMeta: runs.map((r) => ({ cache: r.cache, valid: r.valid, settled: r.out.settled, unsettledAt: r.out.unsettledAt, ...r.out.meta })),
            },
          },
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
