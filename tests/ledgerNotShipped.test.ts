/**
 * ledgerNotShipped.test.ts: the implementation ledger and its generated status
 * document stay in the repository and out of the source archive, and the
 * checks that read them behave correctly in both trees.
 *
 *   docs/releases/V070_IMPLEMENTATION_LEDGER.md
 *   docs/releases/V070_CURRENT_STATUS.md
 *
 * Three properties, each tested against the real file that carries it:
 *
 *   1. `git archive HEAD` carries neither file (the archive is built from it,
 *      scripts/package.sh), and package.sh's internal-material guard names
 *      both, so an archive that did carry them would fail to package.
 *   2. scripts/lint-known-limitations.mjs and scripts/gen-v070-status.mjs, run
 *      as programs in a tree WITHOUT the ledger, pass with a printed SKIPPED
 *      notice when the tree has no .git (an extracted archive) and fail when it
 *      has one (a checkout that lost the file).
 *   3. The same distinction at the function level.
 *
 * Group 1 needs a git checkout and is skipped, visibly, in an extracted
 * archive. Groups 2 and 3 build their own trees and run in either.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEDGER_PATH, STATUS_PATH, isGitCheckout, ledgerSkipNotice } from '../scripts/lib/repoOnlyDocs.mjs';
// @ts-expect-error — plain .mjs script, no types
import { collectKnownLimitationsProblems } from '../scripts/lint-known-limitations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKOUT = isGitCheckout(ROOT);
const BOTH = [LEDGER_PATH, STATUS_PATH] as const;

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });

describe.skipIf(!CHECKOUT)('the source archive (needs a git checkout; skipped in an extracted archive)', () => {
  it('git archive HEAD lists neither document', () => {
    // Limited to docs/releases so the listing stays small; the pathspec does not
    // change which export-ignore rules apply.
    // The archive goes to this test's own file and tar reads it from there.
    // Piping it to `tar -t` on stdin failed with EPIPE under parallel load when
    // tar closed its input before the write finished.
    const dir = mkdtempSync(join(tmpdir(), 'olv-ledger-archive-'));
    let listing: string[];
    try {
      const file = join(dir, 'docs-releases.tar');
      execFileSync('git', ['archive', '--format=tar', '-o', file, 'HEAD', 'docs/releases'], { cwd: ROOT });
      listing = execFileSync('tar', ['-tf', file], { encoding: 'utf8', maxBuffer: 1 << 24 }).split('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(listing.filter((p) => /V070_/.test(p))).toEqual([]);
    // The listing is not simply empty: the shipped release documents are there.
    expect(listing).toContain('docs/releases/KNOWN_LIMITATIONS_v0.7.0.md');
  });

  it('.gitattributes marks both export-ignore, and both are still tracked', () => {
    const attrs = git(['check-attr', 'export-ignore', '--', ...BOTH]);
    for (const p of BOTH) expect(attrs).toContain(`${p}: export-ignore: set`);
    const tracked = git(['ls-files', '--', ...BOTH]).split('\n').filter(Boolean);
    expect(tracked.sort()).toEqual([...BOTH].sort());
  });

  it("package.sh's internal-material guard rejects either file in an assembled archive", () => {
    const sh = readFileSync(join(ROOT, 'scripts/package.sh'), 'utf8');
    const m = /^INTERNAL_PATTERNS='([^']*)'$/m.exec(sh);
    expect(m, 'package.sh defines INTERNAL_PATTERNS').not.toBeNull();
    // The guard is `grep -E` over `find . -type f` paths below the archive's
    // top-level folder, so the pattern sees e.g. openlidarviewer-v0.7.0/docs/....
    const guard = new RegExp(m![1]!);
    for (const p of BOTH) expect(guard.test(`openlidarviewer-v0.7.0/${p}`), p).toBe(true);
    expect(guard.test('openlidarviewer-v0.7.0/docs/releases/KNOWN_LIMITATIONS_v0.7.0.md')).toBe(false);
    expect(guard.test('openlidarviewer-v0.7.0/docs/releases/RELEASE_NOTES_v0.7.0.md')).toBe(false);
  });
});

/** A throwaway tree holding copies of the named repository files. */
function treeWith(files: readonly string[], { dotGit }: { dotGit: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'olv-ledger-tree-'));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  if (dotGit) mkdirSync(join(dir, '.git'));
  return dir;
}

const run = (dir: string, script: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(dir, script), ...args], { cwd: dir, encoding: 'utf8' });

const LIB = ['scripts/lib/isCliEntry.mjs', 'scripts/lib/repoOnlyDocs.mjs'];

describe('scripts/lint-known-limitations.mjs without the ledger', () => {
  const version = '9.9.9';
  const docPath = `docs/releases/KNOWN_LIMITATIONS_v${version}.md`;
  /** The lint's own files, a package.json at a throwaway version, and a document that cites nothing. */
  const build = (dotGit: boolean): string => {
    const dir = treeWith(['scripts/lint-known-limitations.mjs', ...LIB, '.github/workflows/ci.yml'], { dotGit });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
    mkdirSync(join(dir, 'docs/releases'), { recursive: true });
    writeFileSync(join(dir, docPath), '# Known limitations\n\nNothing is cited here.\n');
    return dir;
  };

  it('in an extracted archive (no .git) passes and says the ledger check was skipped', () => {
    const dir = build(false);
    try {
      const r = run(dir, 'scripts/lint-known-limitations.mjs');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(ledgerSkipNotice('lint:known-limitations (c) ledger ids and phrase guards'));
      expect(r.stdout).toContain('lint:known-limitations OK');
      expect(r.stdout).toContain('the ledger check was skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('in a git checkout (.git present) fails: a missing ledger is an error', () => {
    const dir = build(true);
    try {
      const r = run(dir, 'scripts/lint-known-limitations.mjs');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${LEDGER_PATH} is missing.`);
      expect(r.stdout).not.toContain('SKIPPED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with the ledger present, runs the check in either mode (no skip notice)', () => {
    // A minimal ledger, written here: the real one is not in the source archive,
    // and the document under test cites no ledger id.
    const ledger = '# Implementation ledger\n\n| Id | Area | Item | Note | Status |\n|---|---|---|---|---|\n| L01 | test | entry | none | OPEN |\n';
    for (const dotGit of [false, true]) {
      const dir = build(dotGit);
      try {
        mkdirSync(join(dir, 'docs/releases'), { recursive: true });
        writeFileSync(join(dir, LEDGER_PATH), ledger);
        const r = run(dir, 'scripts/lint-known-limitations.mjs');
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).not.toContain('SKIPPED');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe('scripts/gen-v070-status.mjs without the ledger', () => {
  const build = (dotGit: boolean): string =>
    treeWith(['scripts/gen-v070-status.mjs', ...LIB], { dotGit });

  it('--check in an extracted archive skips with a notice and exits 0', () => {
    const dir = build(false);
    try {
      const r = run(dir, 'scripts/gen-v070-status.mjs', '--check');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(ledgerSkipNotice('lint:v070-status'));
      expect(existsSync(join(dir, STATUS_PATH))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writing in an extracted archive also skips, and writes nothing', () => {
    const dir = build(false);
    try {
      const r = run(dir, 'scripts/gen-v070-status.mjs');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('SKIPPED');
      expect(existsSync(join(dir, STATUS_PATH))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--check in a git checkout (.git present) fails and names the missing ledger', () => {
    const dir = build(true);
    try {
      const r = run(dir, 'scripts/gen-v070-status.mjs', '--check');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('lint:v070-status FAILED');
      expect(r.stderr).toContain(`${LEDGER_PATH} is missing from a git checkout`);
      expect(r.stdout).not.toContain('SKIPPED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collectKnownLimitationsProblems and the archive option', () => {
  const noLedger = (p: string): string | null =>
    p === LEDGER_PATH ? null : existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null;

  it('a missing ledger is a problem by default', () => {
    const { problems } = collectKnownLimitationsProblems(noLedger);
    expect(problems).toContain(`${LEDGER_PATH} is missing.`);
  });

  it('a missing ledger is a notice, not a problem, when archive is true', () => {
    const { problems, notices } = collectKnownLimitationsProblems(noLedger, { archive: true });
    expect(problems.filter((p: string) => p.includes('ledger') || p.includes('V070_'))).toEqual([]);
    expect(notices).toEqual([ledgerSkipNotice('lint:known-limitations (c) ledger ids and phrase guards')]);
  });

  it('archive mode skips only the ledger check: a stale bundle sentence still fails', () => {
    const doc = `docs/releases/KNOWN_LIMITATIONS_v${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}.md`;
    const read = (p: string): string | null =>
      p === doc ? `${noLedger(p)}\n\nThe eager bundle measures about 799 KiB against an 812 KiB ceiling.\n` : noLedger(p);
    const { problems } = collectKnownLimitationsProblems(read, { archive: true });
    expect(problems.some((p: string) => p.includes('812 KiB ceiling'))).toBe(true);
  });
});

describe('isGitCheckout', () => {
  it('is true for a root holding .git (directory or file) and false for one without', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olv-ledger-root-'));
    try {
      expect(isGitCheckout(dir)).toBe(false);
      writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere\n'); // a linked worktree
      expect(isGitCheckout(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
