#!/usr/bin/env node
/**
 * check-no-test-seam.mjs: the shipped build carries no Playwright seam.
 *
 * `?test=1` mounts `window.__OLV_TEST_API__` only when the build-time constant
 * `__OLV_TEST_SEAM__` is true (the dev server, or a build with OLV_TEST_SEAM=1).
 * Every other build substitutes `false` and the minifier drops the block. This
 * check reads the built `dist/` (run it after `npm run build:live`) and fails
 * if any emitted file still names the seam or its test-only helpers, so a
 * regression in that define, or a seam added outside the guarded block, cannot
 * reach a deployed page.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Strings that exist only inside the guarded test-seam block of src/main.ts. */
export const TEST_SEAM_MARKERS = [
  '__OLV_TEST_API__',
  '__OLV_TEST_SEAM__',
  'placeMeasurementPoint',
  'is for Playwright only',
];

/** Every marker found in `text`. */
export function findTestSeamMarkers(text) {
  return TEST_SEAM_MARKERS.filter((m) => text.includes(m));
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|html|map|json)$/.test(name)) yield p;
  }
}

export function checkDist(distDir) {
  const problems = [];
  for (const file of walk(distDir)) {
    if (file.endsWith('.map')) continue; // source maps quote the source, not shipped code
    const hits = findTestSeamMarkers(readFileSync(file, 'utf8'));
    if (hits.length) problems.push(`${relative(ROOT, file)}: ${hits.join(', ')}`);
  }
  return problems;
}

if (isCliEntry(import.meta.url)) {
  const dist = resolve(ROOT, process.argv[2] ?? 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`check:no-test-seam: no build at ${relative(ROOT, dist) || dist}. Run "npm run build:live" first.`);
    process.exit(1);
  }
  const problems = checkDist(dist);
  if (problems.length) {
    console.error('check:no-test-seam FAILED: the build contains test-seam code:');
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  console.log(`check:no-test-seam OK: no test-seam marker in ${relative(ROOT, dist)}.`);
}
