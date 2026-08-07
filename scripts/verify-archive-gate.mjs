#!/usr/bin/env node
/**
 * verify-archive-gate.mjs — can the published source actually run its own gate?
 *
 * The release gate runs from a full checkout, but what users download is
 * `git archive` output: the tree minus everything `.gitattributes` marks
 * `export-ignore`. Those are different trees, and a gate stage that reads a
 * file living only in the first one passes for us and dies for them.
 *
 * That is not hypothetical. `lint:architecture-truth` cross-checked a claim in
 * an export-ignored planning document with an unguarded read, so the whole
 * release gate threw ENOENT before the tests or the build ran — for anyone
 * outside this repository, and only for them. A test could not catch it: every
 * test ran in the tree that had the file.
 *
 * So this check reconstructs the published shape and runs every gate lint
 * inside it. A stage that cannot survive there is reported as a defect in the
 * gate, not in the archive.
 *
 * Two failure kinds, deliberately distinguished:
 *   • CRASHED  — an uncaught exception (ENOENT, TypeError). Always a defect:
 *                the stage assumed a file or shape the published tree lacks.
 *   • FAILED   — a controlled non-zero exit. The stage ran and reported a
 *                verdict, which is legitimate behaviour for the checks that
 *                genuinely need repository context (listed below).
 *
 * Run: node scripts/verify-archive-gate.mjs
 */

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// child_process resolves bare command names (git, tar, mkdir) through PATH, so
// a tampered or cwd-relative PATH entry could shadow them with another binary
// (Sonar javascript:S4036). Pin a fixed list of the standard system directories
// those tools live in on the CI runner and on macOS. The lint stages keep the
// inherited PATH — they run npm — and are launched through an absolute /bin/sh.
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/opt/homebrew/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const GIT_ENV = { ...process.env, PATH: SAFE_PATH };

/**
 * Gate stages that read git history or the working copy by design, so they
 * cannot run inside an extracted archive. Each is named with its reason: an
 * entry here is a claim that the stage is repository-only, not a way to quiet
 * a stage that broke.
 */
const REPO_ONLY = new Map([
  ['lint:no-tracked-ignored', 'compares the git index against .gitignore'],
  ['lint:release-sync', 'diffs the publish tree against its source of truth'],
  ['lint:sbom', 'resolves the installed dependency tree'],
]);

/** The lint stages of `test:release:execute`, in gate order. */
function gateLints() {
  const pkg = JSON.parse(execSync('git show HEAD:package.json', { cwd: ROOT, encoding: 'utf8', env: GIT_ENV }));
  const chain = pkg.scripts['test:release:execute'] ?? '';
  return chain
    .split('&&')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('npm run lint:'))
    .map((s) => s.replace(/^npm run\s+/, '').split(/\s+/)[0]);
}

const stages = gateLints();
if (stages.length === 0) {
  console.error('verify-archive-gate FAILED\n\n  • found no lint stages in test:release:execute.');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'olv-archive-gate-'));
const tree = join(work, 'tree');
let crashed = [];
let failed = [];
let passed = 0;

try {
  // The published shape: HEAD with every export-ignore rule applied.
  execSync(`mkdir -p "${tree}" && git archive --format=tar HEAD | tar -x -C "${tree}"`, {
    cwd: ROOT,
    stdio: 'pipe',
    env: GIT_ENV,
  });

  // The lints are plain Node ESM; a few import dev dependencies. Borrowing the
  // installed tree keeps this check about missing SOURCE, not missing packages.
  const mods = resolve(ROOT, 'node_modules');
  if (existsSync(mods) && !existsSync(join(tree, 'node_modules'))) {
    symlinkSync(mods, join(tree, 'node_modules'), 'dir');
  }

  const pkg = JSON.parse(execSync('git show HEAD:package.json', { cwd: ROOT, encoding: 'utf8', env: GIT_ENV }));

  for (const stage of stages) {
    if (REPO_ONLY.has(stage)) continue;
    const cmd = pkg.scripts[stage];
    if (!cmd) {
      crashed.push([stage, `no such script: ${stage}`]);
      continue;
    }
    try {
      execFileSync('/bin/sh', ['-c', cmd], { cwd: tree, stdio: 'pipe', encoding: 'utf8' });
      passed += 1;
    } catch (err) {
      const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      // An uncaught throw prints a stack; a lint that ran prints its own
      // verdict. The distinction is the whole point of this check.
      const isCrash = /^\s*(?:node:internal|\w*Error:)/m.test(text) || /\bat .+:\d+:\d+/.test(text);
      // Report the line that names the cause, not whichever line came first —
      // a stack begins with its own frame header ("node:fs:436"), which tells
      // the reader nothing about which file was missing.
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const why =
        lines.find((l) => /(?:ENOENT|no such file|required file is missing)/i.test(l)) ??
        lines.find((l) => /^\w*Error:/.test(l)) ??
        lines.find((l) => /FAILED|•/.test(l)) ??
        lines[0] ??
        `exit ${err.status}`;
      (isCrash ? crashed : failed).push([stage, why]);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (crashed.length > 0) {
  console.error('verify-archive-gate FAILED\n');
  for (const [stage, why] of crashed) console.error(`  • ${stage} crashed in the published tree: ${why}`);
  console.error(
    '\nThese stages run from a full checkout and die from `git archive` output.\n' +
      'Guard the read, or stop the gate depending on a file that ships nowhere.',
  );
  process.exit(1);
}

if (failed.length > 0) {
  console.error('verify-archive-gate FAILED\n');
  for (const [stage, why] of failed) console.error(`  • ${stage} reported a failure in the published tree: ${why}`);
  process.exit(1);
}

console.log(
  `verify-archive-gate OK — ${passed} gate lints run against the published tree; ` +
    `${REPO_ONLY.size} skipped as repository-only.`,
);
for (const [stage, why] of REPO_ONLY) console.log(`    (skipped) ${stage} — ${why}`);
