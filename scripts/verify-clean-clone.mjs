#!/usr/bin/env node
/**
 * verify-clean-clone.mjs: can a stranger with only the public repository
 * install it, build it, and run the published validation suites.
 *
 * WHY IT IS A SCRIPT AND NOT A VITEST SUITE. Same reason as
 * `verify-archive-portability.mjs`, which is the precedent: the whole question
 * is what exists outside this working tree, and importing an application module
 * would pull in the Vite `BUILD_IDENTITY` define and tie the answer to a build
 * of the tree being questioned. The pure predicates are unit-covered from
 * vitest in `tests/benchmark/cleanClone.test.ts`; nothing here imports `src/`.
 *
 * WHAT IT DOES NOT DUPLICATE. `benchmark:archive-portability` already checks an
 * extracted release archive with no repository around it: that every link
 * resolves, every import has a manifest entry, every documented script exists.
 * It recorded the install and build leg as unrun, because an archive has no
 * lockfile install to perform. That leg is this script's job:
 * `npm ci`, `check:deps`, the build, `check:bundle` and `docs:build`, executed
 * against a tree containing nothing but what the repository publishes.
 *
 * HOW A MISSING FILE ACTUALLY FAILS. The tree under test is materialised with
 * `git archive HEAD`, which emits tracked content at HEAD and nothing else. An
 * untracked file, a gitignored fixture, a build artefact left in the working
 * directory and a tool that only exists on the author's machine are all absent
 * from it by construction, so a script or an import that needs one fails there
 * while passing in the working tree. `--drop <path>` removes a named file after
 * extraction, which is the mutation that proves the checks react rather than
 * merely pass.
 *
 * The repository's own `.gitignore` carries a note about exactly this failure:
 * an unanchored `build` pattern once matched `src/build/`, untracking
 * `src/build/buildIdentity.ts` and breaking a clean checkout's typecheck while
 * every working tree kept building. That file is in REQUIRED_PATHS below.
 *
 * Usage:
 *   node scripts/verify-clean-clone.mjs                # presence leg only, seconds
 *   node scripts/verify-clean-clone.mjs --install      # + npm ci, build, docs. Minutes.
 *   node scripts/verify-clean-clone.mjs --drop <path>  # negative control
 *   node scripts/verify-clean-clone.mjs --keep         # leave the tree for inspection
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireBinaryOnPath } from './lib/binaryOnPath.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

// Spawned programs are resolved to an absolute path by reading PATH, so the
// path that runs is a value this script can name rather than whatever the OS
// picks up. See scripts/lib/binaryOnPath.mjs.
const GIT = requireBinaryOnPath('git');
const TAR = requireBinaryOnPath('tar');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files a fresh clone must carry for the install and build leg to be possible
 * at all. Every one is named with the reason it is here; a list without reasons
 * decays into a list nobody dares change.
 *
 * The script-referenced files are NOT listed: they are derived from
 * `package.json` by `scriptFileTargets`, which `verify-archive-portability.mjs`
 * already owns. Two hand-maintained lists of the same thing drift.
 */
export const REQUIRED_PATHS = Object.freeze({
  'package.json': 'the manifest npm ci installs from',
  'package-lock.json': 'npm ci refuses to run without a lockfile, and an npm install would resolve a different tree',
  'tsconfig.json': 'typecheck and the build both read it',
  'vite.config.ts': 'the build config, including the chunk-emission guard',
  'vitest.config.ts': 'defines BUILD_IDENTITY, without which every suite fails to import',
  'index.html': 'the Vite entry document',
  'src/build/buildIdentity.ts':
    'the file an unanchored gitignore pattern once untracked, breaking a clean checkout while every working tree still built',
  'docs-site/.vitepress/config.mts': 'docs:build has no site without it',
  'scripts/check-dep-singletons.mjs': 'check:deps, one of the two legs the archive suite recorded as unrun',
  'scripts/check-bundle-budget.mjs': 'check:bundle, the other leg the archive suite recorded as unrun',
  'scripts/render-claim-register.mjs': 'docs:build renders the claim register first',
  'scripts/lint-docs-site.mjs': 'docs:build lints the rendered site',
});

/** Tracked paths at HEAD. The exact contents a stranger's clone would have. */
export function trackedPaths(root = REPO_ROOT) {
  const out = execFileSync(GIT, ['ls-tree', '-r', '--name-only', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

/** Which of `wanted` is absent from `present`. Pure, so it is unit-testable. */
export function missingFrom(wanted, present) {
  const have = new Set(present);
  return wanted.filter((p) => !have.has(p));
}

/**
 * Whether a path is a directory prefix of something present — a script target
 * like `docs-site/` is satisfied by any file under it.
 */
export function satisfiedByPrefix(path, present) {
  if (!path.endsWith('/')) return false;
  return present.some((p) => p.startsWith(path));
}

/** Materialise HEAD into `dest` using git archive: tracked content, nothing else. */
export function materialise(dest, root = REPO_ROOT) {
  mkdirSync(dest, { recursive: true });
  const archive = execFileSync(GIT, ['archive', '--format=tar', 'HEAD'], {
    cwd: root,
    maxBuffer: 512 * 1024 * 1024,
  });
  execFileSync(TAR, ['-x', '-C', dest], { input: archive, maxBuffer: 512 * 1024 * 1024 });
  return dest;
}

function run(label, command, args, cwd) {
  process.stdout.write(`\n── ${label}\n   ${command} ${args.join(' ')}\n`);
  const r = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  const code = r.status === null ? 1 : r.status;
  process.stdout.write(`   exit=${code}\n`);
  return { label, code };
}

async function main() {
  const argv = process.argv.slice(2);
  const install = argv.includes('--install');
  const keep = argv.includes('--keep');
  const dropAt = argv.indexOf('--drop');
  const drop = dropAt === -1 ? null : argv[dropAt + 1];

  // The tree under test comes from `git archive HEAD`, so this needs a
  // repository. An extracted source archive has none, and the archive
  // portability suite runs every node-only script inside one. Say so in a
  // sentence a caller can classify, rather than letting git's own "not a git
  // repository" reach the caller as an ordinary failure.
  if (!existsSync(join(REPO_ROOT, '.git'))) {
    process.stderr.write(
      'clean-clone needs a git repository: the tree under test is materialised ' +
        'from git archive HEAD, and this directory is not a repository. ' +
        'Not run.\n',
    );
    return 3;
  }

  const dest = mkdtempSync(join(tmpdir(), 'olv-clean-clone-'));
  const failures = [];
  try {
    materialise(dest);
    process.stdout.write(`clean tree: ${dest}\n`);

    if (drop) {
      const target = join(dest, drop);
      if (!existsSync(target)) {
        process.stderr.write(`--drop: ${drop} is not in the materialised tree; nothing to remove\n`);
        return 2;
      }
      rmSync(target, { recursive: true, force: true });
      process.stdout.write(`negative control: removed ${drop} from the clean tree\n`);
    }

    // ── Presence leg ─────────────────────────────────────────────────────────
    const present = trackedPaths().filter((p) => existsSync(join(dest, p)));

    const missingRequired = missingFrom(Object.keys(REQUIRED_PATHS), present);
    for (const p of missingRequired) {
      failures.push(`required file absent from a clean clone: ${p} (${REQUIRED_PATHS[p]})`);
    }

    // Every file the npm scripts execute, derived rather than listed twice.
    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
    // A file URL, not a raw path. `dest` is under the temp directory, so on
    // Windows the specifier would start `C:\…` and ESM would read `C:` as a
    // URL scheme; the `.catch` below would then turn that into a confident
    // report that the file is missing from the clone, which it is not.
    const { scriptFileTargets } = await import(
      pathToFileURL(join(dest, 'scripts', 'verify-archive-portability.mjs')).href
    ).catch(() => ({ scriptFileTargets: null }));
    if (typeof scriptFileTargets === 'function') {
      const targets = scriptFileTargets(pkg.scripts ?? {});
      for (const t of missingFrom(targets, present)) {
        if (satisfiedByPrefix(t, present)) continue;
        failures.push(`an npm script runs a file a clean clone does not have: ${t}`);
      }
    } else {
      failures.push(
        'scripts/verify-archive-portability.mjs is not in a clean clone, so the script-target derivation could not run',
      );
    }

    process.stdout.write(
      `\npresence leg: ${present.length} tracked files materialised, ` +
        `${Object.keys(REQUIRED_PATHS).length} required paths checked, ${failures.length} failure(s)\n`,
    );

    // ── Install and build leg ────────────────────────────────────────────────
    if (install && failures.length === 0) {
      const steps = [
        ['install from the lockfile', 'npm', ['ci', '--no-audit', '--no-fund']],
        ['lockfile unchanged by the install', 'git', ['--no-pager', 'diff', '--exit-code', '--', 'package-lock.json']],
        ['typecheck', 'npm', ['run', 'typecheck']],
        ['dependency singletons', 'npm', ['run', 'check:deps']],
        ['build', 'npm', ['run', 'build']],
        ['bundle budget', 'npm', ['run', 'check:bundle']],
        ['docs site', 'npm', ['run', 'docs:build']],
      ];
      for (const [label, cmd, args] of steps) {
        // `git diff` needs a repository; the materialised tree has none, so the
        // lockfile check is meaningful only in CI where the checkout is a clone.
        if (cmd === 'git' && !existsSync(join(dest, '.git'))) {
          process.stdout.write(
            `\n── ${label}\n   skipped: the materialised tree is not a git repository. ` +
              'The clean-clone workflow performs this check on its own checkout.\n',
          );
          continue;
        }
        const { code } = run(label, cmd, args, dest);
        if (code !== 0) failures.push(`${label} failed in a clean clone (exit ${code})`);
      }
    } else if (install) {
      process.stdout.write('\ninstall leg not attempted: the presence leg already failed\n');
    }
  } finally {
    if (keep) process.stdout.write(`\nclean tree kept at ${dest}\n`);
    else rmSync(dest, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write('\nCLEAN CLONE: FAIL\n');
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    return 1;
  }
  process.stdout.write('\nCLEAN CLONE: PASS\n');
  return 0;
}

if (isCliEntry(import.meta.url)) {
  process.exit(await main());
}
