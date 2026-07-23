#!/usr/bin/env node
/**
 * lint-position-access.mjs — a ratchet on direct `.positions` reads.
 *
 * The coordinate-integrity work replaces the destructive in-place rebase with
 * a Float64 transform applied at the boundary. Its size is set by how many
 * places reach into `cloud.positions` directly, so that surface must not grow
 * while the decomposition moves code around.
 *
 * MEASURED, and it is smaller than the roadmap assumed. Of the reads in
 * `src/`, only a handful combine positions with an origin; most files do
 * purely source-local maths (volumes, density, colours, profile sampling) and
 * are CORRECT reading Float32 source-local coordinates. They need no
 * migration at all. The transform is needed at the boundaries that produce
 * world or project coordinates, not everywhere positions are touched.
 *
 * So this is a ratchet, not a ban. Counts may fall, never rise. A file that
 * drops to zero is removed from the baseline and can never come back.
 *
 * To lower the baseline after removing reads: `node scripts/lint-position-access.mjs --update`.
 * There is deliberately no flag to RAISE it. A new direct read means either
 * routing through the transform boundary instead, or a considered decision
 * recorded by editing the baseline by hand.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/position-access-baseline.json');
const SRC = resolve(ROOT, 'src');

/** Every .ts file under src/, excluding tests. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Count direct `.positions` reads, ignoring comments.
 *
 * A comment mentioning the field is documentation, not a call site, and
 * counting it would make the ratchet fire on someone explaining the migration.
 */
function countReads(file) {
  const text = readFileSync(file, 'utf8');
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
    const stripped = raw.replace(/\/\/.*$/, '');
    n += (stripped.match(/\.positions\b/g) ?? []).length;
  }
  return n;
}

const current = {};
for (const file of walk(SRC)) {
  const n = countReads(file);
  if (n > 0) current[relative(ROOT, file)] = n;
}

const update = process.argv.includes('--update');

if (update || !existsSync(BASELINE)) {
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  writeFileSync(BASELINE, `${JSON.stringify({ total, files: current }, null, 2)}\n`);
  console.log(`position-access baseline written — ${total} reads across ${Object.keys(current).length} files.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const problems = [];

for (const [file, n] of Object.entries(current)) {
  const allowed = baseline.files[file];
  if (allowed === undefined) {
    problems.push(`${file}: ${n} direct .positions read(s) in a file that had none. Route through the transform boundary, or add it to the baseline deliberately.`);
  } else if (n > allowed) {
    problems.push(`${file}: ${n} direct .positions reads, baseline ${allowed}. The migration surface may shrink, never grow.`);
  }
}

const total = Object.values(current).reduce((a, b) => a + b, 0);
if (total > baseline.total) {
  problems.push(`total ${total} reads, baseline ${baseline.total}.`);
}

if (problems.length > 0) {
  console.error('lint:position-access FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nSee docs/architecture/project-spatial-frame.md for the transform boundary.');
  process.exit(1);
}

const shrunk = baseline.total - total;
console.log(
  `lint:position-access OK — ${total} direct reads across ${Object.keys(current).length} files`
  + (shrunk > 0 ? ` (${shrunk} fewer than baseline; run --update to lower it).` : '.'),
);
