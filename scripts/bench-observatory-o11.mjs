#!/usr/bin/env node
/**
 * bench-observatory-o11.mjs: runs the O11 overlay benchmark exactly as
 * validation/protocols/observatory-o11-v1.md fixes it, and writes the record
 * to validation/performance/observatory-o11/<date>-<sha>-<machine>.json.
 *
 * Order: every scenario's field is built, the slicing arm is measured on all
 * four, the budgets are written into the record file, and only then is the
 * instancing arm measured. The verdict is applied by scripts/lib/observatoryO11.mjs.
 *
 *   OLV_O11_MACHINE=mbp-local node scripts/bench-observatory-o11.mjs
 *
 * Runs headed Chromium through Playwright against a Vite dev server of the
 * benchmark page (benchmarks/observatory-o11/), never the app build.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { O11_PROTOCOL, O11_SCENARIOS, budgetsFromSlicing, decideO11, summariseArm } from './lib/observatoryO11.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = 3;
const MACHINE = process.env.OLV_O11_MACHINE ?? 'local';
const ONLY = process.env.OLV_O11_ONLY ? process.env.OLV_O11_ONLY.split(',') : O11_SCENARIOS;

const sha = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: ROOT }).toString().trim();
const date = new Date().toISOString().slice(0, 10);
const outDir = join(ROOT, 'validation', 'performance', 'observatory-o11');
const outFile = join(outDir, `${date}-${sha}-${MACHINE}.json`);
mkdirSync(outDir, { recursive: true });

const record = {
  protocol: O11_PROTOCOL,
  commit: sha,
  date,
  machine: MACHINE,
  os: `${process.platform} ${release()}`,
  browser: null,
  backend: null,
  runsPerArm: RUNS,
  scenarios: {},
  slicing: {},
  budgets: null,
  instancing: {},
  verdict: null,
};
const save = () => writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);

const server = await createServer({ configFile: false, root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const url = `${server.resolvedUrls.local[0]}benchmarks/observatory-o11/index.html`;
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--enable-unsafe-webgpu'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.setDefaultTimeout(0);
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready');
  record.browser = `chromium ${browser.version()}`;

  for (const id of ONLY) {
    const info = await page.evaluate((i) => window.__o11.prepare(i), id);
    record.backend = info.backend;
    record.scenarios[id] = info;
    console.log(`prepared ${id}: ${JSON.stringify(info)}`);
  }
  for (const id of ONLY) {
    const runs = [];
    for (let r = 0; r < RUNS; r++) runs.push(await page.evaluate((i) => window.__o11.measure(i, 'slicing'), id));
    record.slicing[id] = { runs, ...summariseArm(runs) };
    console.log(`slicing ${id}: ${JSON.stringify(record.slicing[id])}`);
  }
  if (ONLY.length !== O11_SCENARIOS.length) {
    save();
    console.log(`partial run (${ONLY.join(',')}), no budgets or verdict: ${outFile}`);
    process.exit(0);
  }
  record.budgets = budgetsFromSlicing(record.slicing);
  record.budgetsFixedAt = new Date().toISOString();
  save();
  console.log(`budgets fixed and written before instancing: ${JSON.stringify(record.budgets)}`);

  for (const id of ONLY) {
    const runs = [];
    for (let r = 0; r < RUNS; r++) {
      runs.push(await page.evaluate((i) => window.__o11.measure(i, 'instancing'), id).catch((e) => ({ ok: false, error: String(e) })));
      if (!runs[runs.length - 1].ok) break;
    }
    record.instancing[id] = { runs, ...summariseArm(runs) };
    console.log(`instancing ${id}: ${JSON.stringify(record.instancing[id])}`);
  }
  record.verdict = decideO11(record.slicing, record.instancing);
  save();
  console.log(`verdict: ${record.verdict.chosen}\n${outFile}`);
} finally {
  await browser.close();
  await server.close();
}
