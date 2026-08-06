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
 *
 * SCOPE: `outside-model`, which is NARROWER than the gate's `all-src`. The gate
 * counts the model too, so its total is legitimately higher; both count through
 * the same rule in scripts/lib/positionReads.mjs, so the difference is exactly
 * the reads in `src/model/`. Each scanner prints its scope for that reason —
 * two numbers for one surface are fine when the scope is stated, and a bug when
 * it is not.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPES, positionReadLines, walkPositionSources } from './lib/positionReads.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const SCOPE = SCOPES['outside-model'];

/**
 * The `.positions` reads in a file, as { line, text, count }. Comment lines are
 * skipped and trailing `//` comments stripped, by the same helper the enforcing
 * ratchet counts with, so a line that only MENTIONS the field in prose
 * (explaining the migration, say) is not reported as a call site — and the
 * report can never list a site the gate does not count.
 */
const readsIn = (file) => positionReadLines(readFileSync(file, 'utf8'));

const posix = (p) => p.split(sep).join('/');

const files = walkPositionSources(SRC, SCOPE);
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
console.log(`Scope ${SCOPE.id}: ${SCOPE.label}.`);
console.log('Destination: docs/architecture/float64-frame-migration-plan.md · roadmap P1 #2.');
console.log(report.join('\n'));
console.log(`\nTotal: ${totalReads} direct .positions reads across ${totalFiles} files (scope ${SCOPE.id}).`);
console.log('This is a report, not a gate. The gate is `npm run lint:position-access`, which holds');
console.log('the count shrink-only AND requires every read to name its coordinate frame in');
console.log('docs/validation/position-frames.json. Its total is HIGHER because its scope is');
console.log('all-src: it counts src/model/ too, where the accessors themselves read the buffer.');

process.exit(0);
