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
import { readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBinaryOnPath } from './lib/binaryOnPath.mjs';

// Spawned programs are resolved to an absolute path by reading PATH, so the
// path that runs is a value this script can name rather than whatever the OS
// picks up. See scripts/lib/binaryOnPath.mjs.
const GIT = requireBinaryOnPath('git');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files that describe the leak rather than contain one.
 *
 * Each entry is a hole, so each says why it is here. A file whose subject is
 * path redaction has to quote a path to explain itself, and on a CI runner the
 * home directory is `/home/runner`, which one of these quotes verbatim. The
 * alternative is loosening the pattern until it stops matching real leaks.
 */
const DESCRIBES_THE_PATTERN = new Map([
  ['scripts/lint-no-host-paths.mjs', 'this file names the patterns it searches for'],
  [
    'benchmarks/framework/artifacts.ts',
    'documents why an absolute path is stripped from a record, quoting one',
  ],
]);

/**
 * Identifiers of the machine running the check.
 *
 * Only path-shaped values qualify. An earlier version also matched the bare
 * account name, which fails on a CI runner: the account there is `runner`, and
 * the workflows legitimately contain that word many times over. It also matched
 * a hyphenated temporary directory, and on Linux `/tmp` flattens to `tmp`,
 * which appears in .gitignore. A pattern that common reports the whole
 * repository and teaches everyone to ignore the check.
 *
 * A value is used only when it is long enough and carries a separator, so it
 * names a location rather than a word. The leak this exists to catch is the
 * home directory embedded in a path, in either form, and both survive the
 * filter: `/Users/name` and its flattened `Users-name`.
 */
function hostPatterns() {
  const patterns = [];
  const MIN_LENGTH = 8;

  /** A location, not a word: long enough and containing a separator. */
  const specific = (value) =>
    typeof value === 'string' && value.length >= MIN_LENGTH && /[/\\-]/.test(value);

  const add = (value, label) => {
    if (specific(value)) patterns.push({ value, label });
  };

  const home = homedir();
  add(home, 'this home directory');
  // The original leak travelled with separators flattened to hyphens, which is
  // how a scratch directory encodes the path it belongs to.
  add(home.replace(/[/\\]/g, '-').replace(/^-/, ''), 'this home directory, flattened');

  const tmp = tmpdir();
  add(tmp, 'this temporary directory');
  add(tmp.replace(/[/\\]/g, '-').replace(/^-/, ''), 'this temporary directory, flattened');

  // Longest first, so a finding reports the most specific match.
  return patterns.sort((a, b) => b.value.length - a.value.length);
}

/** Directories a filesystem walk must not enter: never tracked, or generated. */
const WALK_SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'release',
  'test-results',
  'coverage',
  'playwright-report',
  '.claude',
  '.venv',
  '__pycache__',
]);

/** True when the file list came from a filesystem walk rather than git. */
let archiveMode = false;

/**
 * Every tracked file, since anything tracked can reach the source archive.
 * A source archive carries no `.git`, and a check that cannot run must not
 * report success — but an archive's files ARE the shipped set, so the walk
 * below scans exactly what the archive ships and the verdict stays earned.
 */
function trackedFiles() {
  try {
    return execFileSync(GIT, ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch {
    archiveMode = true;
    const files = [];
    const walk = (rel) => {
      for (const entry of readdirSync(resolve(ROOT, rel === '' ? '.' : rel), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (WALK_SKIP.has(entry.name)) continue;
        const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(next);
        else files.push(next);
      }
    };
    walk('');
    return files;
  }
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
  console.error('  • No path-shaped identifier for this machine, so nothing was checked.');
  console.error('\nA check that cannot run must not report success.');
  process.exit(1);
}

const problems = [];
let scanned = 0;
for (const file of trackedFiles()) {
  if (DESCRIBES_THE_PATTERN.has(file)) continue;
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
  `lint:no-host-paths OK — ${scanned} ${archiveMode ? 'walked (archive mode: no git history)' : 'tracked'} ` +
    `text file(s) name none of this machine’s ${patterns.length} identifier(s).`,
);
