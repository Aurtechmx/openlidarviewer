#!/usr/bin/env node
/**
 * lint-positions-reads.mjs — a REPORT-ONLY inventory of direct `.positions`
 * reads outside `src/model/`.
 *
 * This is the running companion to docs/architecture/float64-frame-migration-plan.md.
 * It prints, grouped by file with `file:line`, every place outside the model
 * that reaches into a cloud's `.positions` buffer directly. That surface is the
 * exact set of call sites the Float64 project-frame migration (roadmap P1 #2)
 * has to move onto the world-space accessor — and because that migration must
 * land ATOMICALLY (a half-migrated tree has render in project space while the
 * CPU is still source-local), it helps to see the whole surface in one place.
 *
 * IT IS NOT A GATE. It ALWAYS exits 0. Nothing in `test:release:execute`,
 * `gate.sh`, or any commit hook should ever fail because of this script. The
 * enforcing ratchet is the separate `lint:position-access`
 * (scripts/lint-position-access.mjs), which holds the count shrink-only against
 * a committed baseline. This one only shows you the list; that one keeps it
 * from growing. Keeping the two apart is deliberate: a report you can run any
 * time without it ever blocking you, and a gate that never prints a wall of
 * output on a clean tree.
 *
 * `src/model/` is excluded because that is where `.positions` is SUPPOSED to be
 * read — PointCloud owns the buffer and the `worldXYZ` / `projectXYZ`
 * accessors. `*.test.ts` is excluded because a test asserting on positions is
 * not a consumer to migrate.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const MODEL = resolve(SRC, 'model');

/** Every non-test `.ts` file under src/, excluding the model internals. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (full === MODEL) continue; // the model owns the buffer; not a consumer
      out.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The `.positions` reads in a file, as { line, text }. Comment lines are
 * skipped and trailing `//` comments stripped, the same way the enforcing
 * ratchet counts, so a line that only MENTIONS the field in prose (explaining
 * the migration, say) is not reported as a call site.
 */
function readsIn(file) {
  const text = readFileSync(file, 'utf8');
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    const stripped = lines[i].replace(/\/\/.*$/, '');
    const n = (stripped.match(/\.positions\b/g) ?? []).length;
    if (n > 0) hits.push({ line: i + 1, text: trimmed, count: n });
  }
  return hits;
}

const posix = (p) => p.split(sep).join('/');

const files = walk(SRC).sort();
let totalReads = 0;
let totalFiles = 0;
const report = [];

for (const file of files) {
  const hits = readsIn(file);
  if (hits.length === 0) continue;
  totalFiles += 1;
  const rel = posix(relative(ROOT, file));
  const fileCount = hits.reduce((a, h) => a + h.count, 0);
  totalReads += fileCount;
  report.push(`\n${rel}  (${fileCount} read${fileCount === 1 ? '' : 's'})`);
  for (const h of hits) report.push(`  ${rel}:${h.line}  ${h.text}`);
}

console.log('lint:positions-reads — REPORT ONLY (never fails a gate)');
console.log('Direct `.positions` reads outside src/model/ (excludes *.test.ts).');
console.log('Destination: docs/architecture/float64-frame-migration-plan.md · roadmap P1 #2.');
console.log(report.join('\n'));
console.log(`\nTotal: ${totalReads} direct .positions reads across ${totalFiles} files.`);
console.log('This is a report, not a gate. The shrink-only ratchet is `npm run lint:position-access`.');

process.exit(0);
