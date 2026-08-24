/**
 * prHygiene.test.ts — proves the PR-hygiene lint REJECTS, and for the stated
 * reason, and that it does NOT reject the healthy branches it resembles.
 *
 * The rule that matters is the replay predicate, and it is the one easiest to
 * write backwards: `redundant` counts surface files IDENTICAL to the base, not
 * files that differ. Inverted, it would flag every honest PR and pass the
 * pathological one, and both mistakes look the same in a green CI run. The
 * predicate therefore gets its direction pinned explicitly, and the
 * merely-behind case exists to fail if the two-dot and three-dot measurements
 * are ever swapped.
 *
 * `collectHygieneProblems` takes an observation, so the rule cases are a
 * function of what they pass. `observeBranch` reads real history, so it is
 * tested against real repositories built in a temp directory: the important one
 * is a branch cut from a parent that is then squash-merged, which is how the
 * 103-commit, 48-redundant-file PR happened.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { collectHygieneProblems, observeBranch, REDUNDANT_LIMIT } from '../scripts/pr-hygiene.mjs';

interface Report { errors: string[]; warnings: string[] }

const run = (o: Record<string, unknown>): Report => collectHygieneProblems(o) as Report;
const ids = (msgs: string[]) => msgs.map((m) => m.slice(1, m.indexOf(' ')));

/** A healthy PR: a few files, nothing already upstream, no merges. */
const CLEAN = {
  baseRef: 'main',
  allowedBases: ['main'],
  surface: ['src/a.ts', 'tests/a.test.ts'],
  redundant: [],
  realCount: 2,
  mergeCommits: [],
  commitsBehind: 0,
  openPrCount: 3,
};

describe('pr-hygiene — the healthy shapes it must not reject', () => {
  it('passes a clean branch', () => {
    expect(run(CLEAN)).toEqual({ errors: [], warnings: [] });
  });

  it('passes a branch that is merely behind, whose two-dot delta is huge', () => {
    // The trap: `real` counts main's newer files, so it dwarfs the surface on
    // any stale branch. Judging replay by `real` would condemn this one.
    const report = run({ ...CLEAN, realCount: 166, commitsBehind: 9 });
    expect(report.errors).toEqual([]);
  });

  it('passes a wide refactor with nothing redundant, noting the width only', () => {
    const surface = Array.from({ length: 60 }, (_, i) => `src/m${i}.ts`);
    const report = run({ ...CLEAN, surface, realCount: 60 });
    expect(report.errors).toEqual([]);
    expect(ids(report.warnings)).toContain('W5');
  });

  it('passes a large generated evidence record, because size is not scope', () => {
    const report = run({
      ...CLEAN,
      surface: ['validation/x/reference-runs.json'],
      realCount: 1,
      generatedFiles: ['validation/x/reference-runs.json'],
    });
    expect(report.errors).toEqual([]);
    expect(ids(report.warnings)).toContain('W4');
  });

  it('warns but never fails on queue depth, so a security fix is not blocked', () => {
    const report = run({ ...CLEAN, openPrCount: 14 });
    expect(report.errors).toEqual([]);
    expect(ids(report.warnings)).toContain('W2');
  });

  it('warns but never fails on a stale base', () => {
    const report = run({ ...CLEAN, commitsBehind: 120 });
    expect(report.errors).toEqual([]);
    expect(ids(report.warnings)).toContain('W3');
  });
});

describe('pr-hygiene — the structural rejections', () => {
  it('H1 rejects a PR targeting a branch this repository does not merge into', () => {
    const report = run({ ...CLEAN, baseRef: 'release/v1', allowedBases: ['main'] });
    expect(ids(report.errors)).toContain('H1');
    expect(report.errors[0]).toContain('release/v1');
  });

  it('H2 rejects merge commits where linear history is required', () => {
    const report = run({ ...CLEAN, mergeCommits: ['abc Merge branch main'] });
    expect(ids(report.errors)).toContain('H2');
  });

  it('H2 stays quiet where linear history is not required', () => {
    const report = run({ ...CLEAN, mergeCommits: ['abc Merge'], linearHistoryRequired: false });
    expect(report.errors).toEqual([]);
  });

  it('H3 rejects a surface mostly identical to the base, and names the files', () => {
    const surface = ['src/real.ts', 'src/old1.ts', 'src/old2.ts', 'src/old3.ts'];
    const report = run({ ...CLEAN, surface, redundant: surface.slice(1), realCount: 1 });
    expect(ids(report.errors)).toContain('H3');
    expect(report.errors.find((e) => e.startsWith('[H3'))).toContain('src/old1.ts');
  });

  it('H3 tells the reader to rebase rather than to add a waiver', () => {
    const surface = ['a', 'b', 'c', 'd'];
    const report = run({ ...CLEAN, surface, redundant: ['b', 'c', 'd'], realCount: 1 });
    const h3 = report.errors.find((e) => e.startsWith('[H3')) as string;
    expect(h3).toContain('Rebase onto current main');
    expect(h3).toContain('do not add a waiver');
  });

  it('H3 fails on a small surface once the redundant SHARE is material', () => {
    // Two of four is under REDUNDANT_LIMIT but half the review is noise.
    expect(REDUNDANT_LIMIT).toBe(3);
    const report = run({ ...CLEAN, surface: ['a', 'b', 'c', 'd'], redundant: ['a', 'b'], realCount: 2 });
    expect(ids(report.errors)).toContain('H3');
  });

  it('H3 only warns on a single redundant file in a wide surface', () => {
    const surface = Array.from({ length: 30 }, (_, i) => `src/m${i}.ts`);
    const report = run({ ...CLEAN, surface, redundant: ['src/m0.ts'], realCount: 30 });
    expect(report.errors).toEqual([]);
    expect(ids(report.warnings)).toContain('W1');
  });

  it('H4 rejects a surface far larger than the real delta WHEN files are upstream', () => {
    const surface = Array.from({ length: 56 }, (_, i) => `f${i}`);
    const report = run({ ...CLEAN, surface, redundant: surface.slice(8), realCount: 8 });
    expect(ids(report.errors)).toContain('H4');
  });

  it('H4 stays quiet when the surface is large but nothing is upstream', () => {
    // A genuinely wide change against a stale base must not read as replay.
    const surface = Array.from({ length: 56 }, (_, i) => `f${i}`);
    const report = run({ ...CLEAN, surface, redundant: [], realCount: 8 });
    expect(ids(report.errors)).not.toContain('H4');
  });
});

describe('observeBranch — measured against real history', () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (path: string, body: string, message: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'olv-hygiene-'));
    git('init', '-q', '-b', 'main');
    commit('base.txt', 'base\n', 'base');

    // A parent branch does two files of work.
    git('checkout', '-q', '-b', 'parent');
    commit('parent1.txt', 'one\n', 'parent one');
    commit('parent2.txt', 'two\n', 'parent two');

    // A child is cut FROM the parent and adds its own file.
    git('checkout', '-q', '-b', 'child');
    commit('child.txt', 'child\n', 'child work');

    // The parent is then SQUASH-merged into main. Its two commits are replaced
    // by one that is not an ancestor of the child, so the child's merge-base
    // with main stays at `base` and the parent's files reappear in its surface.
    git('checkout', '-q', 'main');
    git('merge', '--squash', '-q', 'parent');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'parent work (#1)');

    // A second branch is cut from main AFTER the squash and is merely behind.
    git('checkout', '-q', '-b', 'behind', 'main');
    commit('behind.txt', 'b\n', 'behind work');
    git('checkout', '-q', 'main');
    commit('later.txt', 'later\n', 'main moves on');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('measures a squash-merged-parent replay: the parent files are redundant', () => {
    const o = observeBranch('main', 'child', { allowedBases: ['main'] }, dir) as {
      surface: string[]; redundant: string[]; realCount: number; mergeCommits: string[];
    };
    // Surface shows the child's own file AND the parent's two, already upstream.
    expect(o.surface.sort()).toEqual(['child.txt', 'parent1.txt', 'parent2.txt']);
    expect(o.redundant.sort()).toEqual(['parent1.txt', 'parent2.txt']);
    const report = run({ ...o, baseRef: 'main', allowedBases: ['main'] });
    expect(ids(report.errors)).toContain('H3');
  });

  it('pins the predicate direction: the child\'s OWN file is never redundant', () => {
    // Inverting the predicate would put child.txt here and drop the parent
    // files, which is the mutation this case exists to kill.
    const o = observeBranch('main', 'child', {}, dir) as { redundant: string[] };
    expect(o.redundant).not.toContain('child.txt');
  });

  it('measures a merely-behind branch as clean, however far behind it is', () => {
    const o = observeBranch('main', 'behind', { allowedBases: ['main'] }, dir) as {
      surface: string[]; redundant: string[]; realCount: number;
    };
    expect(o.surface).toEqual(['behind.txt']);
    expect(o.redundant).toEqual([]);
    // The two-dot delta also counts what main gained: the trap this guards.
    expect(o.realCount).toBeGreaterThan(o.surface.length);
    expect(run({ ...o, baseRef: 'main', allowedBases: ['main'] }).errors).toEqual([]);
  });

  it('counts merge commits on a branch that merges main in', () => {
    git('checkout', '-q', '-b', 'merger', 'behind');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', 'main', '-m', 'Merge main');
    const o = observeBranch('main', 'merger', { allowedBases: ['main'] }, dir) as { mergeCommits: string[] };
    expect(o.mergeCommits.length).toBe(1);
    expect(ids(run({ ...o, baseRef: 'main', allowedBases: ['main'] }).errors)).toContain('H2');
  });
});
