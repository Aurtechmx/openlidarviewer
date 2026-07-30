#!/usr/bin/env node
/**
 * lint-no-host-paths.mjs — no tracked file may name the machine it was built on.
 *
 * A reference runner recorded each external tool invocation verbatim, including
 * the absolute path of a temporary worktree. That put the account name into 404
 * places across two committed JSON records, along with the numeric user id and a
 * session identifier. The source archive is `git archive HEAD`, `validation/`
 * carries no export-ignore rule, and the packaging script matches filenames
 * rather than file contents, so nothing downstream would have seen it.
 *
 * A marker list already exists for the same failure, in
 * scripts/defect-replay-lib.mjs, and it lists the right prefixes. It is scoped to
 * defect-replay captures and never sees anything under validation/. The gap was
 * scope, not knowledge, which is why this checks the tree instead of one record
 * type.
 *
 * WHY IT DERIVES THE PATTERNS INSTEAD OF LISTING THEM. A fixed list of prefixes
 * cannot tell a real account from an example. `benchmarks/framework/artifacts.ts`
 * documents redaction using `/Users/alice/checkout/...`, and its tests assert on
 * that string, so a list containing `/Users/` fails the file whose job is to
 * describe the problem. Deriving the identifiers of the machine running the check
 * separates the two exactly: a contributor's own name and home directory are
 * flagged, a fictional one is not, and every contributor is checked against their
 * own machine rather than against whoever wrote the list.
 *
 * The hyphenated form matters as much as the slashed one. The leak that prompted
 * this appeared with the separators flattened to hyphens, because that is how the
 * scratch directory was named, so a search for the slashed form found nothing.
 *
 * Not covered, deliberately, and stated so nobody reads a pass as more than it
 * is: a session or job identifier with no relation to this machine, a hostname,
 * and a path belonging to a different user. A tool's own install location is also
 * not flagged; `/opt/homebrew/Cellar/gdal/3.13.1_4/bin/gdaldem` identifies the
 * binary that produced a measurement, carries no personal data, and is the only
 * pin available when a container is not.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** This file names the patterns it looks for, so it excludes itself. */
const SELF = 'scripts/lint-no-host-paths.mjs';

/**
 * Identifiers of the machine running the check.
 *
 * A username under three characters is rejected as a pattern: it would match
 * ordinary words and every finding after that would be noise.
 */
function hostPatterns() {
  const patterns = [];
  const add = (value, label) => {
    if (typeof value === 'string' && value.length >= 3) {
      patterns.push({ value, label });
    }
  };

  let user = '';
  try {
    user = userInfo().username;
  } catch {
    // Some sandboxes have no passwd entry. The directory patterns still apply.
  }
  add(user, 'this account name');

  const home = homedir();
  add(home, 'this home directory');
  // `/Users/name` also travels as `-Users-name` in a flattened directory name,
  // which is the form the original leak took.
  add(home.replace(/[/\\]/g, '-').replace(/^-/, ''), 'this home directory, hyphenated');

  const tmp = tmpdir();
  add(tmp, 'this temporary directory');
  add(tmp.replace(/[/\\]/g, '-').replace(/^-/, ''), 'this temporary directory, hyphenated');

  // Longest first, so a finding reports the most specific match.
  return patterns.sort((a, b) => b.value.length - a.value.length);
}

/** Every tracked file, since anything tracked can reach the source archive. */
function trackedFiles() {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/** Skip anything that is not text; a binary match would be unreadable anyway. */
function readText(path) {
  try {
    const buf = readFileSync(resolve(ROOT, path));
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

const patterns = hostPatterns();
if (patterns.length === 0) {
  console.error('lint:no-host-paths FAILED\n');
  console.error('  • Could not determine this machine’s identifiers, so nothing was checked.');
  console.error('\nA check that cannot run must not report success.');
  process.exit(1);
}

const problems = [];
let scanned = 0;
for (const file of trackedFiles()) {
  if (file === SELF) continue;
  const text = readText(file);
  if (text === null) continue;
  scanned += 1;
  for (const { value, label } of patterns) {
    const hits = text.split(value).length - 1;
    if (hits > 0) {
      problems.push(`${file}: ${hits} occurrence(s) of ${label}`);
      break; // One finding per file; the fix is the same for all of them.
    }
  }
}

if (problems.length > 0) {
  console.error('lint:no-host-paths FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nTracked files name the machine they were built on, and the source');
  console.error('archive ships whatever is tracked. Record paths relative to the');
  console.error('repository root: a reader cannot use an absolute path from another');
  console.error('machine, so it carries no information and does carry an identity.');
  process.exit(1);
}

console.log(
  `lint:no-host-paths OK — ${scanned} tracked text file(s) name none of this ` +
    `machine’s ${patterns.length} identifier(s).`,
);
