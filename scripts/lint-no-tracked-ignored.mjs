#!/usr/bin/env node
/**
 * lint-no-tracked-ignored.mjs — a file that is git-ignored must not also be
 * tracked.
 *
 * The mirror image of lint-no-ignored-src.mjs. That one catches a file which
 * SHIPS but is ignored, so it vanishes from a clean checkout. This one catches
 * the opposite mistake: a file the .gitignore already names, committed anyway.
 * Being ignored is the author's own statement that it is local tooling and not
 * project source, so tracking it contradicts the repository's own rules and no
 * other check reads it that way.
 *
 * WHY IT EXISTS. A `git add -A` committed 22 files of editor-plugin scaffolding
 * under `.agents/` plus `skills-lock.json`, all of them already listed in
 * .gitignore. They merged through a green pull request and were found by hand
 * days later. The only check that objected was archive portability, which fails
 * for a different reason (the plugin files link to siblings that were never
 * committed, so a release archive has 18 unresolvable links) and reports it as
 * 18 broken-link errors — a poor signal for "somebody committed their editor's
 * plugin folder". This names the actual mistake instead.
 *
 * CASE SENSITIVITY. `git ls-files --ignored` matches patterns through
 * core.ignorecase, which is true by default on macOS and false on the Linux
 * runners. Left to the local default, `*AUDIT*.md` matches the tracked
 * docs/_audit/v0.5.4-terrain-audit.md on a Mac and nothing in CI, so the lint
 * would be red for half the contributors and green on the machine that decides.
 * core.ignorecase=false is pinned below so this judges paths the way CI and
 * `git archive` do. The patterns that matter here (`.agents/`, `skills-lock.json`)
 * are exact-case, so nothing is lost.
 *
 * Exit 0 = clean; exit 1 = a tracked path that .gitignore already excludes.
 */
import { execFileSync } from 'node:child_process';
import { requireBinaryOnPath } from './lib/binaryOnPath.mjs';

// Spawned programs are resolved to an absolute path by reading PATH, so the
// path that runs is a value this script can name rather than whatever the OS
// picks up. See scripts/lib/binaryOnPath.mjs.
const GIT = requireBinaryOnPath('git');

function git(args) {
  return execFileSync(GIT, args, { encoding: 'utf8' });
}

// Only meaningful inside a git working tree. A reviewer running the gate from
// the extracted source archive has no repository and no index, and `git archive`
// cannot contain an ignored file by construction, so the check is vacuously
// satisfied there and must SKIP rather than report a failure the archive can
// never fix. Same contract as lint:no-ignored-src.
try {
  execFileSync(GIT, ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
} catch {
  console.log(
    'lint:no-tracked-ignored SKIPPED — no git repository (source archive); an archive contains only tracked files by construction.'
  );
  process.exit(0);
}

let tracked = '';
try {
  tracked = git([
    '-c',
    'core.ignorecase=false',
    'ls-files',
    '--cached',
    '--ignored',
    '--exclude-standard',
  ]).trim();
} catch (e) {
  console.error('lint:no-tracked-ignored could not run git:', e.message);
  process.exit(1);
}

if (tracked) {
  const paths = tracked.split('\n').filter(Boolean);
  console.error('lint:no-tracked-ignored FAILED');
  console.error('');
  console.error('These paths are TRACKED even though .gitignore excludes them. Being ignored is');
  console.error('this repository saying they are local tooling, not project source:');
  console.error('');
  for (const p of paths) {
    // --no-index is required: check-ignore stays silent about tracked paths
    // without it, which is exactly the set being reported here.
    let rule = '';
    try {
      rule = git(['-c', 'core.ignorecase=false', 'check-ignore', '-v', '--no-index', '--', p])
        .trim()
        .split('\t')[0];
    } catch {
      rule = 'unknown rule';
    }
    console.error(`  • ${p}    (${rule})`);
  }
  console.error('');
  console.error('Fix: `git rm --cached <path>` for local tooling that should never have been');
  console.error('committed. If a path genuinely belongs in the repository, narrow the .gitignore');
  console.error('pattern instead of force-adding it.');
  process.exit(1);
}

console.log('lint:no-tracked-ignored OK — no git-ignored path is tracked');
