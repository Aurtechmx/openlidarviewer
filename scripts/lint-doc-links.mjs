#!/usr/bin/env node
/**
 * lint-doc-links.mjs — a repository path named in a shipped document has to exist.
 *
 * WHY THIS EXISTS. Three release documents cited
 * `docs/release/ERRATUM_v0.6.3.md` and `docs/validation/evidence/portability-v0.6.3/`.
 * Neither was ever created. The evidence behind both was real and sitting under
 * the v0.6.2 names, so the paragraphs were true and the citations were not, and
 * a reader following them to check the claim found nothing.
 *
 * That failure is quiet in the way `lint:html-assets` was written to catch for
 * pages the site serves: nothing throws, no build breaks, and only the person
 * who clicked ever knows. Release documents are exactly where it costs most,
 * because the reader following the link is the one checking whether to believe
 * the claim.
 *
 * Scope is repository-relative paths in Markdown: inline links, reference
 * definitions, and backticked paths that look like files or directories.
 * External URLs are someone else's uptime. Anchors are not resolved, because
 * heading slugs vary by renderer and a wrong anchor is visible where a missing
 * file is not.
 *
 * Exit 0 when every path resolves, 1 when any does not, 2 on a read error.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { binaryOnPath } from './lib/binaryOnPath.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GIT = binaryOnPath('git');

/**
 * Documents a reader follows to check a claim.
 *
 * Not every Markdown file in the repository: `docs/_audit/` and the older
 * planning notes are an archive of what was thought at the time, and their
 * links rotted honestly as the tree moved. Failing the build on those would
 * bury the citations that matter under thirty that do not, which is how a check
 * gets switched off. Pass `--all` to see the archive too.
 */
// CHANGELOG.md is deliberately absent: a changelog records what happened, so an
// entry about removing a file names a file that is now gone. That is the
// document working correctly, and failing on it would teach people to ignore
// this check.
const RELEASE_FACING = [
  // Versioned release documents carry a lowercase "v" and digits, so a
  // pattern of only capitals and underscores silently skipped every one of
  // them, including the three that carried the broken citations this check
  // exists for. The negative control caught that.
  /^(?!CHANGELOG)[A-Z][A-Z_]*(?:_v[\d.]+)?\.md$/,
  /^docs\/release\//,
  /^docs\/validation\//,
  /^validation\//,
];

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

/**
 * The markdown files under check. Git enumerates them in a checkout; a source
 * archive carries no `.git`, so there the walk below enumerates the same
 * shipped set from the filesystem. Returning `[]` without git would make the
 * lint report success over nothing, which it must not.
 */
function markdownFiles() {
  let all;
  try {
    if (GIT === null) throw new Error('git unavailable');
    const out = execFileSync(GIT, ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' });
    all = out.split('\n').filter(Boolean);
  } catch {
    all = [];
    const walk = (rel) => {
      for (const entry of readdirSync(resolve(ROOT, rel === '' ? '.' : rel), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (WALK_SKIP.has(entry.name)) continue;
        const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(next);
        else if (next.endsWith('.md')) all.push(next);
      }
    };
    walk('');
  }
  if (process.argv.includes('--all')) return all;
  return all.filter((f) => RELEASE_FACING.some((re) => re.test(f)));
}

/** A path this repository could hold, as opposed to a URL or a bare word. */
function looksRepoRelative(ref) {
  if (ref === '') return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false; // scheme
  if (ref.startsWith('//') || ref.startsWith('#')) return false;
  if (ref.startsWith('mailto:')) return false;
  return true;
}

/**
 * Backticked paths, which release prose uses far more than link syntax. A
 * backtick span counts only when it looks like a path: it contains a slash and
 * either ends in a directory slash or carries a file extension. `npm run x` and
 * `--flag` are not paths and must not be read as broken ones.
 */
// Directories written by a run rather than committed. Kept explicit: each one
// is a place a wrong path could hide, so the list is short and named.
const GENERATED = /^(?:release|dist|test-results|benchmarks\/out|validation\/reachability)\//;
const ROOTS = 'docs|validation|release|scripts|src|tests|public|benchmarks|\\.github';
const DOC_EXT = 'md|json|ya?ml|ts|mjs|cjs|js|css|html|csv|asc|cff|txt|sh|py|svg|toml';
const CODE_PATH = new RegExp(
  '`(' +
    // At least one slash, so `metadata.intervalM` and `v0.5.x` are not paths,
    // then either a known extension or a trailing slash for a directory.
    // Anchored to real repository roots. Release prose also writes module
    // shorthand like `render/measure/` for src/render/measure/ and package
    // paths like `three/addons/...`; neither is a citation, and treating them
    // as broken links buries the ones that are.
    '(?:' + ROOTS + ')(?:/[A-Za-z0-9._*-]+)+(?:\\.(?:' + DOC_EXT + ')|/)' +
    ')`',
  'g',
);
const INLINE_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const REF_DEF = /^\s*\[[^\]]+\]:\s*(\S+)/gm;

const problems = [];
let checked = 0;

for (const file of markdownFiles()) {
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  const base = dirname(resolve(ROOT, file));
  const seen = new Set();

  const refs = [];
  for (const m of text.matchAll(INLINE_LINK)) refs.push(m[1]);
  for (const m of text.matchAll(REF_DEF)) refs.push(m[1]);
  for (const m of text.matchAll(CODE_PATH)) refs.push(m[1]);

  for (const raw of refs) {
    const ref = raw.split('#')[0].split('?')[0];
    if (!looksRepoRelative(ref)) continue;
    // A glob names a set, not a file. Expanding one here would need the same
    // matcher the shell uses and would still not say which member was meant.
    if (ref.includes('*')) continue;
    // Paths a run produces. They are absent in a clean checkout by design, so
    // their absence is not a broken citation.
    //
    // This started as `release/*.json` alone, and the check then passed or
    // failed depending on whether the machine happened to have run the
    // benchmarks: `benchmarks/out/` existed in one checkout and not in a fresh
    // worktree. A lint whose answer depends on local build state is worse than
    // no lint, because it teaches people the failure is noise.
    if (GENERATED.test(ref)) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    checked++;
    // Resolve against the document, then against the repository root: prose
    // cites both ways and both are legitimate.
    if (existsSync(resolve(base, ref)) || existsSync(join(ROOT, ref))) continue;
    problems.push(`${file}: ${ref}`);
  }
}

if (problems.length > 0) {
  console.error('lint:doc-links FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nA citation that does not resolve is worse than no citation: the reader');
  console.error('following it is the one checking whether to believe the claim.');
  process.exit(1);
}

console.log(
  `lint:doc-links OK — ${checked} repository path(s) across ${markdownFiles().length} document(s) resolve.`,
);
