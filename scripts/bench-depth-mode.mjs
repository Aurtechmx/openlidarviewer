#!/usr/bin/env node
/**
 * bench-depth-mode.mjs: frame time and resolved depth of the three depth
 * modes (standard, logarithmic, reversed) on the viewer's point pipeline, on
 * WebGPU and on the WebGL 2 fallback.
 *
 *   OLV_DEPTH_MACHINE=mbp-local node scripts/bench-depth-mode.mjs
 *
 * Runs headed Chromium through Playwright against a Vite dev server of the
 * benchmark page (scripts/bench/depth-mode/), never the app build. Each arm
 * is its own page load, because the depth mode is fixed when the renderer is
 * built. The arms are interleaved over the runs so drift in the machine's
 * load falls on all of them alike. The record goes to
 * validation/performance/depth-mode/<date>-<sha>-<machine>.json.
 */
import './lib/confineGit.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { DEPTH_MODES as ALL_MODES, resolutionTable, summariseFrames } from './lib/depthModes.mjs';

const DEPTH_MODES = process.env.OLV_DEPTH_MODES ? process.env.OLV_DEPTH_MODES.split(',') : ALL_MODES;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = Number(process.env.OLV_DEPTH_RUNS ?? 3);
const MACHINE = process.env.OLV_DEPTH_MACHINE ?? 'local';
const BACKENDS = (process.env.OLV_DEPTH_BACKENDS ?? 'webgpu,webgl2').split(',');
const SCENARIOS = ['sheets-front-first', 'sheets-back-first', 'terrain'];
const SHAPES = [{ id: 'round', round: true }, { id: 'square', round: false }];
const SIZE_PX = 3;
const NEAR = 0.1;
const FAR = 5_000_000;

const sha = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: ROOT }).toString().trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT }).toString().trim() !== '';
const date = new Date().toISOString().slice(0, 10);
const outDir = process.env.OLV_DEPTH_OUT ?? join(ROOT, 'validation', 'performance', 'depth-mode');
const outFile = join(outDir, `${date}-${sha}-${MACHINE}.json`);
mkdirSync(outDir, { recursive: true });

const record = {
  benchmark: 'depth-mode-v1',
  commit: sha,
  dirty,
  date,
  machine: MACHINE,
  os: `${process.platform} ${release()}`,
  browser: null,
  canvas: '1280x800, pixel ratio 1, MSAA',
  points: 3_000_000,
  pointSizePx: SIZE_PX,
  near: NEAR,
  far: FAR,
  runsPerArm: RUNS,
  storedResolutionM: resolutionTable(NEAR, FAR),
  arms: {},
};
const save = () => writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);

const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const base = `${server.resolvedUrls.local[0]}scripts/bench/depth-mode/index.html`;
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});
record.browser = `chromium ${browser.version()}`;
browser.on('disconnected', () => console.log('  browser disconnected'));
// One idle page stays open, so closing an arm's page never leaves the browser without a window.
const keepAlive = await browser.newPage();

async function withArm(backend, depth, fn) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.setDefaultTimeout(0);
  page.on('crash', () => console.log(`  page crashed (${backend}/${depth})`));
  page.on('pageerror', (e) => console.log(`  page error (${backend}/${depth}): ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  console ${m.type()} (${backend}/${depth}): ${m.text().slice(0, 300)}`); });
  try {
    await page.goto(`${base}?depth=${depth}&backend=${backend}`);
    await page.waitForFunction(() => /^(ready|error)/.test(document.getElementById('log')?.textContent ?? ''), null, { timeout: 60_000 });
    const state = await page.evaluate(() => document.getElementById('log').textContent);
    if (state !== 'ready') throw new Error(`${backend}/${depth}: ${state}`);
    return await fn(page);
  } finally {
    await page.close();
  }
}

try {
  // What each arm actually got, and the gap its depth buffer resolves.
  for (const backend of BACKENDS) {
    for (const depth of DEPTH_MODES) {
      const key = `${backend}/${depth}`;
      record.arms[key] = await withArm(backend, depth, async (page) => {
        const info = await page.evaluate(() => window.__depth.info());
        // three.js falls back quietly when WebGPU fails or reversed depth is unavailable.
        if (info.backend !== backend) throw new Error(`${key}: the page ran on ${info.backend}`);
        const got = info.reversedDepthBuffer ? 'reversed' : info.logarithmicDepthBuffer ? 'log' : 'standard';
        if (got !== depth) throw new Error(`${key}: the renderer used ${got} depth`);
        const gaps = [];
        for (const d of [10, 100, 1000, 10_000, 50_000]) gaps.push(await page.evaluate((x) => window.__depth.resolvedGap(x), d));
        return { info, resolved: gaps, frames: {} };
      });
      console.log(`${key}: ${JSON.stringify(record.arms[key].info)}`);
      console.log(`  resolved gap / distance: ${record.arms[key].resolved.map((g) => `${g.d} m: ${g.resolvedRelativeGap ?? 'none'}`).join(', ')}`);
    }
  }
  save();

  // Frame times, the arms interleaved run by run.
  const all = {};
  for (let run = 0; run < RUNS; run++) {
    for (const backend of BACKENDS) {
      for (const depth of DEPTH_MODES) {
        const key = `${backend}/${depth}`;
        await withArm(backend, depth, async (page) => {
          for (const scenario of SCENARIOS) {
            for (const shape of SHAPES) {
              const res = await page.evaluate(([s, rd, px]) => window.__depth.measure(s, rd, px), [scenario, shape.round, SIZE_PX]);
              const cell = `${scenario}/${shape.id}`;
              ((all[key] ??= {})[cell] ??= []).push(res.ok ? res.times : null);
            }
          }
        });
        console.log(`run ${run + 1}/${RUNS} ${key} done`);
      }
    }
  }
  for (const [key, cells] of Object.entries(all)) {
    for (const [cell, runs] of Object.entries(cells)) {
      const ok = runs.filter(Boolean);
      const perRun = ok.map((t) => summariseFrames(t).medianMs);
      record.arms[key].frames[cell] = { ...summariseFrames(ok.flat()), runMediansMs: perRun, failedRuns: runs.length - ok.length };
    }
  }
  save();

  const fmt = (v) => (v == null ? '   n/a' : v.toFixed(2).padStart(6));
  for (const backend of BACKENDS) {
    console.log(`\n${backend}: median frame ms (p95)`);
    console.log(`${'scenario / shape'.padEnd(30)}${DEPTH_MODES.map((m) => m.padStart(18)).join('')}`);
    for (const scenario of SCENARIOS) {
      for (const shape of SHAPES) {
        const cell = `${scenario}/${shape.id}`;
        const cols = DEPTH_MODES.map((m) => {
          const f = record.arms[`${backend}/${m}`]?.frames[cell];
          return `${fmt(f?.medianMs)} (${fmt(f?.p95Ms)})`.padStart(18);
        });
        console.log(`${cell.padEnd(30)}${cols.join('')}`);
      }
    }
  }
  console.log(`\n${outFile}`);
} finally {
  await browser.close();
  await server.close();
}
