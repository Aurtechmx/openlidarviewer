/**
 * positionReads.mjs — the one definition of "a direct `.positions` read".
 *
 * Three scripts count this surface, for three different reasons:
 *
 *   lint-position-access.mjs   the gate: shrink-only, plus a frame per read
 *   lint-architecture-truth.mjs  cross-checks the migration plan's stated count
 *   lint-positions-reads.mjs   the report: the live `file:line` list
 *
 * Each used to carry its own copy of the walk and its own copy of the counting
 * rule. The copies were textually identical, which is exactly why they were
 * dangerous: nothing tied them together, so a fix to one (a new comment form, a
 * tightened regex) would silently leave the other two measuring something else,
 * and the repo would then hold two authoritative-looking answers to one
 * question. `lint:architecture-truth` exists to stop documents contradicting
 * the tree; it contradicting the gate would undo its own point.
 *
 * So the detection rule lives here once and the three scripts import it. They
 * do NOT all share a scope, and that difference is real rather than
 * accidental — see SCOPES below. What they share is that any two numbers taken
 * from this module differ ONLY by their declared scope, never by their idea of
 * what a read is. Every caller prints the scope it used, so the numbers are
 * comparable instead of merely different.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two scopes anyone has a reason to count.
 *
 * `all-src` is the gate's scope. The gate asks "how much code touches this
 * buffer at all, and does each site know which frame it is in?", and
 * `src/model/` has to be in that answer: `PointCloud` and `pointFrames` are
 * where the raw reads are MOST load-bearing, because every accessor other code
 * is supposed to use is built out of them. A frame mistake there is wrong
 * everywhere at once.
 *
 * `outside-model` is the migration's scope. The Float64 project-frame migration
 * moves CONSUMERS onto the accessors; the model is the thing being moved onto,
 * not a consumer to migrate. Counting the model in that number would inflate a
 * work estimate with work that does not exist.
 *
 * Two questions, two honest answers. The difference between them is exactly the
 * reads inside `src/model/`, and nothing else.
 */
export const SCOPES = {
  'all-src': {
    id: 'all-src',
    label: 'all of src/ (excluding *.test.ts)',
    excludeModel: false,
  },
  'outside-model': {
    id: 'outside-model',
    label: 'src/ excluding src/model/ and *.test.ts',
    excludeModel: true,
  },
};

/**
 * The pattern. `\b` keeps `.positionsBuffer` out of the count; the leading dot
 * keeps a bare local named `positions` out of it.
 */
const POSITIONS_RE = /\.positions\b/g;

/**
 * The direct `.positions` reads on one line.
 *
 * A comment mentioning the field is documentation, not a call site, and
 * counting it would fire the gate on someone explaining the migration. This is
 * the ORIGINAL detection rule from the gate, moved here unchanged; the other
 * two scanners were already using a byte-identical copy of it.
 */
export function readsOnLine(raw) {
  const line = raw.trim();
  if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) return 0;
  const stripped = raw.replace(/\/\/.*$/, '');
  return (stripped.match(POSITIONS_RE) ?? []).length;
}

/** Total direct `.positions` reads in a file's text. */
export function countPositionReads(text) {
  let n = 0;
  for (const raw of text.split('\n')) n += readsOnLine(raw);
  return n;
}

/**
 * Every read in a file's text as `{ line, text, count }`, 1-based.
 *
 * The report needs the sites, the other two only need the total. Deriving both
 * from `readsOnLine` is what stops the report from listing a line the gate does
 * not count, or the reverse.
 */
export function positionReadLines(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const count = readsOnLine(lines[i]);
    if (count > 0) hits.push({ line: i + 1, text: lines[i].trim(), count });
  }
  return hits;
}

/**
 * Every non-test `.ts` file in a scope, sorted, as absolute paths.
 *
 * `*.test.ts` is excluded in both scopes: a test asserting on positions is not
 * a consumer to migrate and not a site whose frame needs recording.
 */
export function walkPositionSources(srcDir, scope) {
  const model = join(srcDir, 'model');
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (scope.excludeModel && full === model) continue;
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  walk(srcDir);
  return out.sort();
}

/**
 * Scan a scope: `{ scope, byFile, total, fileCount }`, where `byFile` maps an
 * absolute path to its read count and holds only files with at least one.
 *
 * Callers that need per-symbol detail (the gate) or per-line detail (the
 * report) build it from `walkPositionSources` and the line helpers above, so
 * they still count through this module's rule rather than around it.
 */
export function scanPositionReads(srcDir, scopeId) {
  const scope = SCOPES[scopeId];
  if (!scope) throw new Error(`unknown position-read scope: ${scopeId}`);
  const byFile = new Map();
  let total = 0;
  for (const file of walkPositionSources(srcDir, scope)) {
    const n = countPositionReads(readFileSync(file, 'utf8'));
    if (n === 0) continue;
    byFile.set(file, n);
    total += n;
  }
  return { scope, byFile, total, fileCount: byFile.size };
}
