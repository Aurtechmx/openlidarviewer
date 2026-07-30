/**
 * integrationMerge.test.ts — pins the parts of scripts/integration-merge.mjs
 * that can be silently wrong.
 *
 * The script's job is to answer one question: does this SET of branches pass the
 * gate together. Three things decide whether the answer means anything, and none
 * of them involve git:
 *
 *   • input parsing — a mistyped PR number read as a branch name would resolve
 *     to nothing, or worse, to a branch that happens to be named like a number;
 *   • the ordering rule — merge order changes the resulting tree, so an order
 *     that depended on argv would make a green run unreproducible;
 *   • the verdict — a conflict, a gate failure and a tracked-but-ignored file
 *     must not be reported as the same outcome, and none of them may be
 *     reported as a pass.
 *
 * Nothing here spawns git or performs a merge. A test that did would be slow,
 * would need fixture branches to stay alive, and would still not pin any of the
 * three rules above.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no types
import { classifyToken, parseArgs, orderResolved, dedupeResolved, quickGateCommand, classifyRun, formatSummary, DEFAULT_GATE, DEFAULT_BASE, EXIT_CODES, FAILURE_KINDS, QUICK_GATE_EXCLUDED } from '../scripts/integration-merge.mjs';

const BASE = { ref: 'origin/main', sha: 'adf9ca2d501a71b46f66eafcc486dfae5cb27870' };

describe('classifyToken — branch names and PR numbers in one argument list', () => {
  it('reads a bare number as a PR', () => {
    expect(classifyToken('127')).toMatchObject({ kind: 'pr', number: 127 });
  });

  it('reads #127 as a PR', () => {
    expect(classifyToken('#127')).toMatchObject({ kind: 'pr', number: 127 });
  });

  it('reads a pull-request URL as a PR', () => {
    expect(classifyToken('https://github.com/Aurtechmx/openlidarviewer/pull/127')).toMatchObject({
      kind: 'pr',
      number: 127,
    });
    expect(classifyToken('https://github.com/Aurtechmx/openlidarviewer/pull/127/files')).toMatchObject({
      kind: 'pr',
      number: 127,
    });
  });

  it('reads a slashed name as a branch', () => {
    expect(classifyToken('wave2/dataset-register')).toMatchObject({
      kind: 'branch',
      name: 'wave2/dataset-register',
    });
  });

  it('does not read a branch whose name merely contains digits as a PR', () => {
    expect(classifyToken('feat/v0.5.2')).toMatchObject({ kind: 'branch', name: 'feat/v0.5.2' });
    expect(classifyToken('release-127')).toMatchObject({ kind: 'branch', name: 'release-127' });
  });

  it('lets an all-digit BRANCH be named explicitly', () => {
    expect(classifyToken('branch:127')).toMatchObject({ kind: 'branch', name: '127' });
    expect(classifyToken('pr:127')).toMatchObject({ kind: 'pr', number: 127 });
  });

  it('rejects an unknown option instead of merging a branch called --oops', () => {
    expect(classifyToken('--oops')).toMatchObject({ kind: 'invalid' });
  });

  it('rejects a malformed forced form', () => {
    expect(classifyToken('pr:abc')).toMatchObject({ kind: 'invalid' });
    expect(classifyToken('branch:')).toMatchObject({ kind: 'invalid' });
  });
});

describe('parseArgs', () => {
  it('accepts branches and PR numbers mixed, in any position', () => {
    const { inputs, errors } = parseArgs(['wave1/preset-truth', '127', '--quick', '#129', 'wave2/stats-core']);
    expect(errors).toEqual([]);
    expect(inputs.map((i: { kind: string }) => i.kind)).toEqual(['branch', 'pr', 'pr', 'branch']);
  });

  it('defaults to the release gate on origin/main, fetching first', () => {
    const { options } = parseArgs(['wave1/preset-truth']);
    expect(options).toMatchObject({
      gate: DEFAULT_GATE,
      base: DEFAULT_BASE,
      quick: false,
      fetch: true,
      runGate: true,
      keep: false,
      strictIgnored: false,
    });
  });

  it('takes flag values both space- and equals-separated', () => {
    expect(parseArgs(['--gate', 'npm test', 'a']).options.gate).toBe('npm test');
    expect(parseArgs(['--gate=npm test', 'a']).options.gate).toBe('npm test');
    expect(parseArgs(['--base=origin/release', 'a']).options.base).toBe('origin/release');
  });

  it('sets the negative flags', () => {
    const { options } = parseArgs(['--no-fetch', '--no-gate', '--keep', '--strict-ignored', 'a']);
    expect(options).toMatchObject({ fetch: false, runGate: false, keep: true, strictIgnored: true });
  });

  it('refuses --quick together with an explicit --gate rather than picking one', () => {
    // Silently preferring one would mean the summary names a gate that did not run.
    expect(parseArgs(['--quick', '--gate', 'npm test', 'a']).errors).toEqual([
      '--quick and --gate both set a gate command; pass one',
    ]);
  });

  it('errors when no branch is given', () => {
    expect(parseArgs([]).errors).toEqual(['no branches or PR numbers given']);
    expect(parseArgs(['--quick']).errors).toEqual(['no branches or PR numbers given']);
  });

  it('does not require a branch for --help', () => {
    const { help, errors } = parseArgs(['--help']);
    expect(help).toBe(true);
    expect(errors).toEqual([]);
  });

  it('ignores the npm argument separator', () => {
    // `npm run integration:merge -- wave1/x` forwards the `--`.
    const { inputs, errors } = parseArgs(['--', 'wave1/preset-truth']);
    expect(errors).toEqual([]);
    expect(inputs).toHaveLength(1);
  });

  it('reports a flag with a missing value', () => {
    expect(parseArgs(['a', '--gate']).errors).toContain('--gate needs a value');
  });
});

describe('orderResolved — the ordering rule', () => {
  const a = { branch: 'wave1/preset-truth', ref: 'origin/wave1/preset-truth', sha: 'aaa1111' };
  const b = { branch: 'wave1/queue-hardening', ref: 'wave1/queue-hardening (local)', sha: 'bbb2222' };
  const c = { branch: 'wave2/stats-core', ref: 'origin/wave2/stats-core', sha: 'ccc3333' };

  it('sorts by branch name, not by argv order', () => {
    expect(orderResolved([c, a, b]).map((x: { branch: string }) => x.branch)).toEqual([
      'wave1/preset-truth',
      'wave1/queue-hardening',
      'wave2/stats-core',
    ]);
  });

  it('gives the same order for every permutation of the same set', () => {
    const perms = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];
    const orders = perms.map((p) => orderResolved(p).map((x: { sha: string }) => x.sha).join(','));
    expect(new Set(orders).size).toBe(1);
  });

  it('does not depend on where a branch resolved from', () => {
    const remote = { branch: 'wave1/x', ref: 'origin/wave1/x', sha: 'ddd4444' };
    const local = { branch: 'wave1/a', ref: 'wave1/a (local)', sha: 'eee5555' };
    expect(orderResolved([remote, local]).map((x: { branch: string }) => x.branch)).toEqual([
      'wave1/a',
      'wave1/x',
    ]);
  });

  it('breaks a name tie on the sha so the order is still total', () => {
    const one = { branch: 'same', ref: 'origin/same', sha: 'fff0000' };
    const two = { branch: 'same', ref: 'same (local)', sha: 'aaa0000' };
    expect(orderResolved([one, two]).map((x: { sha: string }) => x.sha)).toEqual(['aaa0000', 'fff0000']);
  });

  it('does not mutate its input', () => {
    const input = [c, a, b];
    orderResolved(input);
    expect(input.map((x) => x.branch)).toEqual([c.branch, a.branch, b.branch]);
  });

  it('sorts by code unit, not by locale collation', () => {
    // A locale-aware comparison can rank these differently between machines,
    // which would silently change the merge order and therefore the tree.
    const items = [
      { branch: 'Z-branch', ref: 'origin/Z-branch', sha: '1' },
      { branch: 'a-branch', ref: 'origin/a-branch', sha: '2' },
    ];
    expect(orderResolved(items).map((x: { branch: string }) => x.branch)).toEqual(['Z-branch', 'a-branch']);
  });
});

describe('dedupeResolved — a branch given twice, once as its PR number', () => {
  it('keeps one entry and reports the repeat', () => {
    const item = { branch: 'wave2/dataset-register', ref: 'origin/wave2/dataset-register', sha: 'abc1234', raw: '127' };
    const dup = { ...item, raw: 'wave2/dataset-register' };
    const { unique, duplicates } = dedupeResolved([item, dup]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });

  it('leaves distinct branches alone and ordered', () => {
    const { unique, duplicates } = dedupeResolved([
      { branch: 'b', ref: 'origin/b', sha: '2' },
      { branch: 'a', ref: 'origin/a', sha: '1' },
    ]);
    expect(unique.map((x: { branch: string }) => x.branch)).toEqual(['a', 'b']);
    expect(duplicates).toEqual([]);
  });
});

describe('quickGateCommand', () => {
  const scripts = ['typecheck', 'lint:sbom', 'test', 'lint:evidence', 'lint:csp-html', 'build'];

  it('is typecheck, then every lint gate, then vitest run', () => {
    expect(quickGateCommand(scripts)).toBe(
      'npm run typecheck && npm run lint:csp-html && npm run lint:sbom && npx vitest run',
    );
  });

  it('excludes the lints that need a gate log rather than a tree', () => {
    expect(quickGateCommand(scripts)).not.toContain('lint:evidence');
    expect(QUICK_GATE_EXCLUDED).toContain('lint:evidence');
  });

  it('is order-independent in its input, so package.json key order cannot change it', () => {
    expect(quickGateCommand([...scripts].reverse())).toBe(quickGateCommand(scripts));
  });

  it('picks up a lint a branch adds, without a second edit here', () => {
    expect(quickGateCommand([...scripts, 'lint:new-rule'])).toContain('npm run lint:new-rule');
  });
});

describe('classifyRun — failure classification', () => {
  const clean = [{ branch: 'a', sha: '1', status: 'clean', conflicts: [] }];

  it('passes only when every leg passed', () => {
    const v = classifyRun({ merges: clean, gate: { command: 'x', exitCode: 0 }, addedIgnored: [] });
    expect(v).toMatchObject({ kind: FAILURE_KINDS.NONE, exitCode: EXIT_CODES.OK });
  });

  it('treats an unresolved input as the first failure — nothing was merged', () => {
    const v = classifyRun({ unresolved: ['#999'], merges: [], gate: null });
    expect(v).toMatchObject({ kind: FAILURE_KINDS.RESOLVE, exitCode: EXIT_CODES.RESOLVE });
    expect(v.message).toContain('#999');
  });

  it('reports a conflict and names the branch', () => {
    const v = classifyRun({
      merges: [...clean, { branch: 'b', sha: '2', status: 'conflict', conflicts: ['validation/x.yaml'] }],
    });
    expect(v).toMatchObject({ kind: FAILURE_KINDS.CONFLICT, exitCode: EXIT_CODES.CONFLICT });
    expect(v.message).toContain('b');
  });

  it('outranks a gate failure with a conflict — the gate never saw the intended tree', () => {
    const v = classifyRun({
      merges: [{ branch: 'b', sha: '2', status: 'conflict', conflicts: ['f'] }],
      gate: { command: 'x', exitCode: 1 },
      addedIgnored: ['plugin/thing.json'],
    });
    expect(v.kind).toBe(FAILURE_KINDS.CONFLICT);
  });

  it('reports the gate exit code in the message and a distinct status of its own', () => {
    // The gate's code is reported, not reused: gate exit 1 and a merge conflict
    // must not look the same to whatever wraps this script.
    const v = classifyRun({ merges: clean, gate: { command: 'npm run x', exitCode: 1 } });
    expect(v.message).toContain('exited 1');
    expect(v.exitCode).toBe(EXIT_CODES.GATE);
    expect(EXIT_CODES.GATE).not.toBe(EXIT_CODES.CONFLICT);
  });

  it('fails on tracked-but-ignored files even when the gate passed', () => {
    // The second incident: the archive check that would have caught the 22
    // committed plugin files had no pull_request trigger, so a green gate said
    // nothing about them.
    const v = classifyRun({
      merges: clean,
      gate: { command: 'x', exitCode: 0 },
      addedIgnored: ['.idea/workspace.xml', '.vscode/settings.json'],
    });
    expect(v).toMatchObject({
      kind: FAILURE_KINDS.TRACKED_IGNORED,
      exitCode: EXIT_CODES.TRACKED_IGNORED,
    });
    expect(v.message).toContain('.idea/workspace.xml');
  });

  it('passes when no gate ran and nothing else failed', () => {
    expect(classifyRun({ merges: clean, gate: null, addedIgnored: [] }).kind).toBe(FAILURE_KINDS.NONE);
  });

  it('gives every failure class a distinct non-zero code', () => {
    const codes = Object.values(EXIT_CODES).filter((c) => c !== EXIT_CODES.OK);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => (c as number) > 0)).toBe(true);
  });
});

describe('formatSummary', () => {
  const order = [
    { branch: 'wave1/preset-truth', ref: 'origin/wave1/preset-truth', sha: '903fc8e86ca1c5aef3248279' },
    { branch: 'wave2/stats-core', ref: 'wave2/stats-core (local)', sha: 'd0460edea716cc56ac4f57b6' },
  ];

  it('names the merge order used, in order', () => {
    const text = formatSummary({
      base: BASE,
      order,
      merges: order.map((o) => ({ branch: o.branch, sha: o.sha, status: 'clean', conflicts: [] })),
      gate: { command: 'npm run x', exitCode: 0 },
      ignored: { added: [], baseline: [] },
      verdict: classifyRun({
        merges: order.map((o) => ({ branch: o.branch, status: 'clean' })),
        gate: { command: 'npm run x', exitCode: 0 },
      }),
    });
    expect(text).toContain('wave1/preset-truth → wave2/stats-core');
    expect(text).toContain('origin/main @ adf9ca2');
    expect(text).toContain('PASS');
  });

  it('prints the literal gate exit code, not a word for it', () => {
    const text = formatSummary({
      base: BASE,
      order,
      merges: order.map((o) => ({ branch: o.branch, sha: o.sha, status: 'clean', conflicts: [] })),
      gate: { command: 'npm run test:release:execute', exitCode: 1 },
      ignored: { added: [], baseline: ['docs/_audit/old.md'] },
      verdict: { kind: FAILURE_KINDS.GATE, exitCode: EXIT_CODES.GATE, message: 'gate exited 1' },
    });
    expect(text).toContain('gate exit     1');
    expect(text).toContain('FAIL [gate]');
  });

  it('lists the conflicted files and marks the branches it never attempted', () => {
    const merges = [
      { branch: 'wave1/preset-truth', sha: order[0].sha, status: 'conflict', conflicts: ['src/render/x.ts', 'tests/y.test.ts'] },
    ];
    const text = formatSummary({
      base: BASE,
      order,
      merges,
      gate: null,
      ignored: { added: [], baseline: [] },
      verdict: classifyRun({ merges }),
    });
    expect(text).toContain('CONFLICT (2 files)');
    expect(text).toContain('src/render/x.ts');
    expect(text).toContain('tests/y.test.ts');
    expect(text).toContain('not attempted');
    expect(text).toContain('(skipped)');
  });

  it('does not call a gate-less pass an arming result', () => {
    const text = formatSummary({
      base: BASE,
      order: [order[0]],
      merges: [{ branch: order[0].branch, sha: order[0].sha, status: 'clean', conflicts: [] }],
      gate: null,
      ignored: { added: [], baseline: [] },
      verdict: { kind: FAILURE_KINDS.NONE, exitCode: 0, message: 'clean' },
    });
    expect(text).toContain('PASS, NO GATE RAN');
    expect(text).not.toContain('armed for auto-merge');
  });

  it('separates ignored files this merge adds from ones already at the base', () => {
    const text = formatSummary({
      base: BASE,
      order: [order[0]],
      merges: [{ branch: order[0].branch, sha: order[0].sha, status: 'clean', conflicts: [] }],
      gate: { command: 'npm run x', exitCode: 0 },
      ignored: { added: ['.idea/workspace.xml'], baseline: ['docs/_audit/old.md'] },
      verdict: { kind: FAILURE_KINDS.TRACKED_IGNORED, exitCode: EXIT_CODES.TRACKED_IGNORED, message: 'x' },
    });
    expect(text).toContain('1 tracked-but-ignored added by this merge');
    expect(text).toContain('1 already at base');
    expect(text).toContain('.idea/workspace.xml');
  });

  it('is byte-identical for the same result, so two runs diff cleanly', () => {
    const args = {
      base: BASE,
      order,
      merges: order.map((o) => ({ branch: o.branch, sha: o.sha, status: 'clean', conflicts: [] })),
      gate: { command: 'npm run x', exitCode: 0 },
      ignored: { added: [], baseline: [] },
      verdict: { kind: FAILURE_KINDS.NONE, exitCode: 0, message: 'clean' },
    };
    expect(formatSummary(args)).toBe(formatSummary(args));
  });

  it('reports a branch already contained in the base rather than calling it merged', () => {
    const text = formatSummary({
      base: BASE,
      order: [order[0]],
      merges: [{ branch: order[0].branch, sha: order[0].sha, status: 'already-merged', conflicts: [] }],
      gate: { command: 'npm run x', exitCode: 0 },
      ignored: { added: [], baseline: [] },
      verdict: { kind: FAILURE_KINDS.NONE, exitCode: 0, message: 'clean' },
    });
    expect(text).toContain('already in base');
  });
});
