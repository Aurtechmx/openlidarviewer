#!/usr/bin/env node
/**
 * check-bundle-budget.mjs
 *
 * A guard against silent bundle growth. Reads the built `dist/assets/*.js`
 * chunks and fails (exit 1) if a budgeted chunk exceeds its ceiling. Run AFTER
 * a build (the script does not build for you) — `package.sh` invokes it on the
 * live/obfuscated bundle, which is the artifact users actually download, so the
 * ceilings below are sized for that heavier transform, not the dev build.
 *
 * Why this exists: the live transform (obfuscation) inflates `index` and
 * `vendor-three-webgpu` well past their dev sizes, and without a ceiling that
 * creep is invisible until first-load feels slow. Ceilings carry ~10-15 %
 * headroom over the current live sizes so legitimate small growth doesn't trip
 * the gate — raise them deliberately (in a commit) when a real feature needs
 * the room, so the increase is a recorded decision rather than a silent drift.
 *
 * Chunk filenames are content-hashed (`index-B6VKE6qc.js`), so budgets match by
 * the stable prefix before the hash and sum every file that matches (a logical
 * chunk can split). Unbudgeted chunks are listed for visibility but never fail.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'dist', 'assets');

/** prefix (before the -hash.js) → hard ceiling in KiB. */
const BUDGETS = [
  { prefix: 'index', maxKiB: 720, warnKiB: 680 },   // live ~669 KiB after v0.6 P1 (AnalysePanel + ObjectPanel lazy-mounted on scan-load, was 792). Hard ceiling lowered 800→720 to lock in the win and fail a regression well before the old 800; warn at 680 flags creep early. The lazy panels ride their own AnalysePanel-*/ObjectPanel-* chunks — verified by the shell-leak fingerprint guard.
  { prefix: 'vendor-three-webgpu', maxKiB: 1100 },  // live ~978 KiB
  { prefix: 'vendor-pdf', maxKiB: 512 },            // live ~410 KiB
];

function listJs() {
  let names;
  try {
    names = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  } catch {
    console.error(`✗ No build found at ${ASSETS}. Run a build first (npm run build:live).`);
    process.exit(1);
  }
  return names.map((name) => ({ name, kib: statSync(join(ASSETS, name)).size / 1024 }));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A file belongs to `prefix` when it is exactly `<prefix>-<hash>.js` — the hash
 * is a single content-hash token (no further name structure). Anchoring on the
 * prefix avoids mis-splitting chunk names that themselves contain hyphens
 * (e.g. `vendor-three-webgpu-<hash>.js`).
 */
function matchesPrefix(name, prefix) {
  return new RegExp(`^${escapeRe(prefix)}-[A-Za-z0-9_-]{6,12}\\.js$`).test(name);
}

const files = listJs();
let failed = false;

console.log('Bundle budget (live build):');
let warned = false;
for (const { prefix, maxKiB, warnKiB } of BUDGETS) {
  const matched = files.filter((f) => matchesPrefix(f.name, prefix));
  const total = matched.reduce((s, f) => s + f.kib, 0);
  const over = total > maxKiB;
  if (over) failed = true;
  // A soft warning threshold below the hard ceiling: it does NOT fail the gate,
  // it surfaces creep early so a regression is caught long before the ceiling.
  const warn = !over && warnKiB != null && total > warnKiB;
  if (warn) warned = true;
  const pct = Math.round((total / maxKiB) * 100);
  const mark = matched.length === 0 ? '— (missing)' : over ? '✗ OVER' : warn ? '⚠ WARN' : '✓';
  const budgetStr = warnKiB != null ? `${maxKiB} KiB (warn ${warnKiB})` : `${maxKiB} KiB`;
  console.log(
    `  ${mark.padEnd(11)} ${prefix.padEnd(22)} ${total.toFixed(0).padStart(5)} KiB / ${budgetStr}  (${pct}%)`,
  );
}
if (warned) {
  console.warn('\n⚠ A chunk crossed its warning threshold (below the hard ceiling) — investigate creep before it fails the gate.');
}

if (failed) {
  console.error(
    '\n✗ A bundle chunk exceeded its budget. Reduce it, lazy-load more, or raise ' +
      'the ceiling in scripts/check-bundle-budget.mjs as a deliberate, committed decision.',
  );
  process.exit(1);
}
console.log('✓ All budgeted chunks within ceiling.');
