#!/usr/bin/env node
/**
 * verify-archive-tests.mjs — do the unit tests pass in the published source?
 *
 * `verify-archive-gate.mjs` runs the gate's lints inside `git archive` output.
 * The unit tests ran only in the checkout, so two of them passed for us and
 * failed for anyone testing the source archive: one copied an export-ignored
 * document, the other ran `git check-ignore` in a tree with no `.git`.
 *
 * This builds the published tree, with no `.git`, and runs the unit test
 * buckets inside it. A test that needs a checkout must skip itself, visibly,
 * when there is none; one that fails here is a defect in the test.
 *
 * Usage:
 *   node scripts/verify-archive-tests.mjs [--zip <source.zip>] [--install] [bucket ...] [-- <vitest args>]
 *
 *   --zip <file>  test an extracted source archive (scripts/package.sh output)
 *                 instead of `git archive HEAD`
 *   --install     run `npm ci --ignore-scripts` in the tree instead of
 *                 borrowing this checkout's node_modules
 *   bucket        one or more of the scripts/lib/testBuckets.mjs buckets;
 *                 all of them when none is named
 *   -- args       passed to each bucket's vitest run (e.g. --shard=1/3)
 */
import './lib/confineGit.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUCKETS } from './lib/testBuckets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// git, tar and unzip are resolved through a fixed list of system directories
// (see verify-archive-gate.mjs); npm and node keep the inherited PATH.
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/opt/homebrew/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const TOOL_ENV = { ...process.env, PATH: SAFE_PATH };

function parseArgs(argv) {
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const passthrough = dash === -1 ? [] : argv.slice(dash + 1);
  let zip = null;
  let install = false;
  const buckets = [];
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '--zip') zip = resolve(own[++i] ?? '');
    else if (a === '--install') install = true;
    else if (BUCKETS.includes(a)) buckets.push(a);
    else throw new Error(`unknown argument: ${a} (buckets: ${BUCKETS.join(', ')})`);
  }
  return { zip, install, buckets: buckets.length > 0 ? buckets : [...BUCKETS], passthrough };
}

/** The published tree: an extracted source archive, or `git archive HEAD`. */
function buildTree(work, zip) {
  if (zip) {
    if (!existsSync(zip)) throw new Error(`no such archive: ${zip}`);
    const out = join(work, 'zip');
    mkdirSync(out);
    execFileSync('unzip', ['-q', zip, '-d', out], { env: TOOL_ENV, stdio: 'pipe' });
    // scripts/package.sh puts everything under one top-level folder.
    const top = readdirSync(out);
    return top.length === 1 ? join(out, top[0]) : out;
  }
  const tree = join(work, 'tree');
  mkdirSync(tree);
  const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: ROOT, env: TOOL_ENV, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', tree], { input: tar, env: TOOL_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  return tree;
}

const { zip, install, buckets, passthrough } = parseArgs(process.argv.slice(2));
const work = mkdtempSync(join(tmpdir(), 'olv-archive-tests-'));
const failed = [];
try {
  const tree = buildTree(work, zip);
  if (existsSync(join(tree, '.git'))) throw new Error('the published tree holds a .git directory');
  if (install) {
    const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tree, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`npm ci exited ${r.status}`);
  } else {
    // Borrowing the installed tree keeps this check about the published SOURCE.
    const mods = join(ROOT, 'node_modules');
    if (!existsSync(mods)) throw new Error('no node_modules to borrow; run npm ci, or pass --install');
    symlinkSync(mods, join(tree, 'node_modules'), 'dir');
  }
  for (const bucket of buckets) {
    console.log(`\n── ${bucket} bucket in the published tree ──`);
    const r = spawnSync(process.execPath, ['scripts/test-bucket.mjs', bucket, ...passthrough], { cwd: tree, stdio: 'inherit' });
    if (r.status !== 0) failed.push(bucket);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed.length > 0) {
  console.error(
    `\nverify-archive-tests FAILED: ${failed.join(', ')} failed in the published tree (${zip ?? 'git archive HEAD'}).\n` +
      'A test that needs a git checkout or an export-ignored file must skip itself when they are absent.',
  );
  process.exit(1);
}
console.log(`\nverify-archive-tests OK: ${buckets.join(', ')} passed in the published tree (${zip ?? 'git archive HEAD'}).`);
