#!/usr/bin/env node
/**
 * integration-merge.mjs — run the gate over the COMBINATION of several branches
 * before any of them reaches main.
 *
 * WHY THIS EXISTS. Two failure classes, both observed in this repository, are
 * invisible to per-branch CI:
 *
 *  1. Cross-branch interaction. Eight branches were developed in parallel and
 *     each passed its own CI. Merged together, `test:release:execute` exited 1
 *     with 15 failing tests: one branch added
 *     `validation/datasets/dataset-register.yaml`, and another branch's verifier
 *     switches a dataset-id rule from shape-checking to membership-checking when
 *     that file exists. Neither branch fails alone, so no per-PR run of any
 *     depth could have found it. It was found by merging all eight into a
 *     scratch branch by hand and running the suite once.
 *
 *  2. Files that are tracked but git-ignored. A `git add -A` committed 22 files
 *     of editor-plugin scaffolding; archive-portability verification broke on
 *     them while the PR stayed green. This script re-checks the merged index
 *     for that class directly, so the answer does not depend on which checks a
 *     particular trigger happens to run.
 *
 * WHAT IT IS NOT. An operator tool, not a gate. It is deliberately absent from
 * `test:release:execute`: a single-PR trigger cannot express "these five
 * branches together", and wiring a multi-branch merge into the per-commit gate
 * would make every commit depend on the state of unrelated branches.
 *
 * DETERMINISM. Merge order is derived from the input SET (branch name, then
 * commit sha), never from argv order, and the scratch worktree name is a hash of
 * the resolved commits. Nothing here reads the clock or a random source, so two
 * operators handed the same branches produce the same merge sequence and
 * therefore the same tree. Merge commits are dated from the base commit for the
 * same reason.
 *
 * Usage: node scripts/integration-merge.mjs --help
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_GATE = 'npm run test:release:execute';
export const DEFAULT_BASE = 'origin/main';

/**
 * Distinct exit codes per failure class. A caller wrapping this script (a
 * workflow step, a shell loop) can tell "they conflict" from "they merge but
 * the suite fails" without parsing prose. The gate's own exit code is REPORTED
 * literally in the summary and is not reused as this script's status, because
 * gate exit 1 and "conflict" must not look the same to a caller.
 */
export const EXIT_CODES = Object.freeze({
  OK: 0,
  USAGE: 2,
  RESOLVE: 3,
  CONFLICT: 4,
  GATE: 5,
  TRACKED_IGNORED: 6,
});

export const FAILURE_KINDS = Object.freeze({
  NONE: 'none',
  USAGE: 'usage',
  RESOLVE: 'resolve',
  CONFLICT: 'conflict',
  GATE: 'gate',
  TRACKED_IGNORED: 'tracked-ignored',
});

const HELP = `integration-merge — gate the combination of several branches before they land

  node scripts/integration-merge.mjs [options] <branch|PR>...

Inputs may be mixed freely:
  wave1/preset-truth        a branch name (origin/<name> is preferred if it exists)
  127  #127                 a pull request number, resolved with \`gh pr view\`
  https://github.com/o/r/pull/127
  pr:127                    force PR reading of an all-digit token
  branch:127                force branch reading of an all-digit token

Options:
  --quick                   cheaper gate: typecheck + every lint:* + vitest run
  --gate <command>          gate command (default: ${DEFAULT_GATE})
  --base <ref>              base to integrate onto (default: ${DEFAULT_BASE})
  --no-fetch                skip \`git fetch\`; base is whatever is already local
  --no-gate                 merge and check the index, run no gate
  --strict-ignored          fail on ANY tracked-but-ignored file, not only ones
                            this merge adds relative to the base
  --keep                    leave the scratch worktree on disk for inspection
  -h, --help                this text

Exit codes: ${EXIT_CODES.OK} ok · ${EXIT_CODES.USAGE} usage · ${EXIT_CODES.RESOLVE} a ref did not resolve · ${EXIT_CODES.CONFLICT} merge conflict · ${EXIT_CODES.GATE} gate failed · ${EXIT_CODES.TRACKED_IGNORED} tracked-but-ignored files
`;

// ───────────────────────────── pure logic ─────────────────────────────
// Everything below this line is exercised by tests/integrationMerge.test.ts.
// It is pure on purpose: the parts of this tool that can be silently WRONG are
// the parsing, the ordering and the verdict, not the git plumbing. A test that
// spawned real merges would be slow, would need fixture branches, and would
// still not pin the ordering rule.

/**
 * Read one command-line token as a branch or a PR number.
 * A bare number is a PR because that is what operators paste; `branch:127`
 * exists for the repository that really does have a branch named `127`.
 */
export function classifyToken(token) {
  if (token.startsWith('pr:')) {
    const n = token.slice(3);
    return /^\d+$/.test(n)
      ? { kind: 'pr', number: Number(n), raw: token }
      : { kind: 'invalid', raw: token, reason: `pr: needs a number, got "${n}"` };
  }
  if (token.startsWith('branch:')) {
    const name = token.slice(7);
    return name
      ? { kind: 'branch', name, raw: token }
      : { kind: 'invalid', raw: token, reason: 'branch: needs a name' };
  }
  const url = /^https?:\/\/[^\s]*\/pull\/(\d+)(?:[/?#].*)?$/.exec(token);
  if (url) return { kind: 'pr', number: Number(url[1]), raw: token };
  const hash = /^#(\d+)$/.exec(token);
  if (hash) return { kind: 'pr', number: Number(hash[1]), raw: token };
  if (/^\d+$/.test(token)) return { kind: 'pr', number: Number(token), raw: token };
  if (token.startsWith('-')) return { kind: 'invalid', raw: token, reason: 'unknown option' };
  return { kind: 'branch', name: token, raw: token };
}

/** Parse argv (already sliced past node and the script path). */
export function parseArgs(argv) {
  const options = {
    quick: false,
    gate: DEFAULT_GATE,
    base: DEFAULT_BASE,
    fetch: true,
    runGate: true,
    strictIgnored: false,
    keep: false,
  };
  const inputs = [];
  const errors = [];
  let help = false;
  let gateExplicit = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : null;
    const takeValue = (name) => {
      if (inline !== null) return inline;
      const next = argv[++i];
      if (next === undefined) {
        errors.push(`${name} needs a value`);
        return null;
      }
      return next;
    };

    switch (flag) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '--quick':
        options.quick = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--no-fetch':
        options.fetch = false;
        break;
      case '--no-gate':
        options.runGate = false;
        break;
      case '--strict-ignored':
        options.strictIgnored = true;
        break;
      // `npm run integration:merge -- wave1/x` passes the separator through.
      // Reading it as a branch name would fail on something the operator never
      // typed.
      case '--':
        break;
      case '--gate': {
        const v = takeValue('--gate');
        if (v !== null) {
          options.gate = v;
          gateExplicit = true;
        }
        break;
      }
      case '--base': {
        const v = takeValue('--base');
        if (v !== null) options.base = v;
        break;
      }
      default: {
        const parsed = classifyToken(arg);
        if (parsed.kind === 'invalid') errors.push(`${parsed.raw}: ${parsed.reason}`);
        else inputs.push(parsed);
      }
    }
  }

  if (options.quick && gateExplicit) {
    errors.push('--quick and --gate both set a gate command; pass one');
  }
  if (!help && inputs.length === 0) errors.push('no branches or PR numbers given');

  return { help, errors, inputs, options };
}

/**
 * The ordering rule: branch name ascending by code unit, ties broken by commit
 * sha. Not argv order, and not `gh` listing order.
 *
 * Merge order changes the resulting tree whenever two branches touch the same
 * region, so an order that depended on how the operator happened to type the
 * arguments would make a green run unreproducible — the next person could get a
 * different tree from the same set of branches and a different verdict. Sorting
 * on the branch NAME (not the fully qualified ref) keeps the order stable
 * whether a branch resolved from `origin/x` or from a local `x`. `localeCompare`
 * is avoided deliberately: its result depends on the machine's locale.
 */
export function orderResolved(resolved) {
  return [...resolved].sort((a, b) => {
    if (a.branch !== b.branch) return a.branch < b.branch ? -1 : 1;
    if (a.sha !== b.sha) return a.sha < b.sha ? -1 : 1;
    return 0;
  });
}

/** Drop repeats of the same branch (a branch and its PR number both given). */
export function dedupeResolved(resolved) {
  const seen = new Map();
  const duplicates = [];
  for (const item of orderResolved(resolved)) {
    if (seen.has(item.branch)) duplicates.push(item);
    else seen.set(item.branch, item);
  }
  return { unique: [...seen.values()], duplicates };
}

/**
 * The `--quick` gate, composed from the repository's own script names rather
 * than a hand-copied list: a lint added to package.json is picked up here with
 * no second edit, and this cannot drift out of sync the way a duplicated list
 * does. Sorted so the command string is identical on every machine.
 *
 * `lint:evidence` is excluded because it reads a gate log that only a full
 * `npm run evidence` produces; running it here would report a missing file as a
 * cross-branch failure.
 */
export const QUICK_GATE_EXCLUDED = Object.freeze(['lint:evidence']);

export function quickGateCommand(scriptNames) {
  const lints = [...scriptNames]
    .filter((n) => n.startsWith('lint:') && !QUICK_GATE_EXCLUDED.includes(n))
    .sort();
  return ['npm run typecheck', ...lints.map((n) => `npm run ${n}`), 'npx vitest run'].join(' && ');
}

/**
 * Turn the observed state into one verdict. Precedence is "earliest thing that
 * makes the later answers meaningless": an unresolved ref means nothing was
 * merged, a conflict means the gate never ran on the intended tree, and a gate
 * failure means the ignored-files reading describes a tree nobody will ship.
 */
export function classifyRun({
  unresolved = [],
  merges = [],
  gate = null,
  addedIgnored = [],
} = {}) {
  if (unresolved.length > 0) {
    return {
      kind: FAILURE_KINDS.RESOLVE,
      exitCode: EXIT_CODES.RESOLVE,
      message: `${unresolved.length} input(s) did not resolve to a commit: ${unresolved.join(', ')}`,
    };
  }
  const conflicted = merges.filter((m) => m.status === 'conflict');
  if (conflicted.length > 0) {
    return {
      kind: FAILURE_KINDS.CONFLICT,
      exitCode: EXIT_CODES.CONFLICT,
      message: `${conflicted.length} branch(es) conflicted: ${conflicted.map((m) => m.branch).join(', ')}`,
    };
  }
  if (gate && gate.exitCode !== 0) {
    return {
      kind: FAILURE_KINDS.GATE,
      exitCode: EXIT_CODES.GATE,
      // The command is printed on its own line above; repeating it here would
      // push the verdict off the edge of a terminal for a long gate string.
      message: `the gate exited ${gate.exitCode} on the merged tree`,
    };
  }
  if (addedIgnored.length > 0) {
    return {
      kind: FAILURE_KINDS.TRACKED_IGNORED,
      exitCode: EXIT_CODES.TRACKED_IGNORED,
      message: `${addedIgnored.length} tracked-but-ignored file(s) present: ${addedIgnored.join(', ')}`,
    };
  }
  return { kind: FAILURE_KINDS.NONE, exitCode: EXIT_CODES.OK, message: 'clean' };
}

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : '???????');

/** Fixed-width table. Deterministic text so two runs diff cleanly. */
function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells) =>
    cells
      .map((c, i) => String(c ?? '').padEnd(i === cells.length - 1 ? 0 : widths[i]))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/**
 * The report. It names the merge order explicitly, because "the gate passed"
 * is only a fact about one order of one set of commits.
 */
export function formatSummary({
  base,
  order = [],
  merges = [],
  gate = null,
  ignored = { added: [], baseline: [] },
  verdict,
  worktree = null,
  duplicates = [],
  unresolved = [],
}) {
  const out = [];
  out.push('═══ INTEGRATION MERGE SUMMARY ═══');
  out.push(`base          ${base.ref} @ ${short(base.sha)}`);
  out.push(`merge order   ${order.map((o) => o.branch).join(' → ') || '(none)'}`);
  out.push('              sorted by branch name, then sha — determined by the input set, not argv order');
  if (worktree) out.push(`worktree      ${worktree}`);
  out.push('');

  const byBranch = new Map(merges.map((m) => [m.branch, m]));
  out.push(
    table(
      ['#', 'BRANCH', 'SHA', 'RESOLVED FROM', 'MERGE'],
      order.map((o, i) => {
        const m = byBranch.get(o.branch);
        const status = !m
          ? 'not attempted'
          : m.status === 'clean'
            ? 'clean'
            : m.status === 'already-merged'
              ? 'already in base'
              : `CONFLICT (${m.conflicts.length} file${m.conflicts.length === 1 ? '' : 's'})`;
        return [String(i + 1), o.branch, short(o.sha), o.ref, status];
      }),
    ),
  );

  for (const m of merges.filter((x) => x.status === 'conflict')) {
    out.push('');
    out.push(`conflicted files in ${m.branch}:`);
    for (const f of m.conflicts) out.push(`  • ${f}`);
    out.push('  (this branch\'s merge was aborted; the index was left clean)');
  }

  out.push('');
  if (unresolved.length > 0) out.push(`unresolved    ${unresolved.join(', ')}`);
  if (duplicates.length > 0) {
    out.push(`duplicates    ${duplicates.map((d) => d.raw).join(', ')} (already covered by the same branch)`);
  }
  out.push(`gate          ${gate ? gate.command : '(skipped)'}`);
  out.push(`gate exit     ${gate ? gate.exitCode : 'n/a'}${gate && gate.signal ? ` (signal ${gate.signal})` : ''}`);
  out.push(
    `ignored files ${ignored.added.length} tracked-but-ignored added by this merge` +
      (ignored.baseline.length > 0 ? `, ${ignored.baseline.length} already at base` : ''),
  );
  for (const f of ignored.added) out.push(`  • ${f}`);
  out.push('');
  // A pass with no gate is not an arming result. Saying so would let someone
  // arm auto-merge on the strength of a run that only proved the branches merge.
  out.push(
    verdict.kind !== FAILURE_KINDS.NONE
      ? `RESULT        FAIL [${verdict.kind}] ${verdict.message} (exit ${verdict.exitCode})`
      : gate
        ? `RESULT        PASS — this combination is armed for auto-merge (exit ${verdict.exitCode})`
        : `RESULT        PASS, NO GATE RAN — the branches merge and the index is clean; nothing is armed (exit ${verdict.exitCode})`,
  );
  return out.join('\n');
}

// ─────────────────────────── git / process side ───────────────────────────

const MERGE_IDENTITY = Object.freeze([
  '-c',
  'user.name=integration-merge',
  '-c',
  'user.email=integration-merge@localhost',
]);

function git(args, { cwd = REPO_ROOT, env } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function gitTry(args, opts) {
  try {
    return { ok: true, out: git(args, opts) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim(), error: e };
  }
}

/** Resolve one classified token to { branch, ref, sha }, or null with a reason. */
function resolveInput(input, { hasGh }) {
  let branch = input.kind === 'branch' ? input.name : null;

  if (input.kind === 'pr') {
    if (!hasGh) {
      return {
        error: `${input.raw}: PR numbers need the \`gh\` CLI on PATH (https://cli.github.com). Pass the head branch name instead, e.g. \`wave2/dataset-register\`.`,
      };
    }
    const r = spawnSync('gh', ['pr', 'view', String(input.number), '--json', 'headRefName'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout || '').trim().split('\n')[0] || `gh exited ${r.status}`;
      return { error: `${input.raw}: gh pr view failed — ${detail}` };
    }
    try {
      branch = JSON.parse(r.stdout).headRefName;
    } catch {
      return { error: `${input.raw}: gh returned unreadable JSON` };
    }
    if (!branch) return { error: `${input.raw}: PR has no head ref name` };
  }

  // The remote ref is preferred: it is the commit main would actually receive.
  // A local branch with unpushed commits resolves too, and the table prints
  // which one was used so a stale-vs-local difference is visible, not silent.
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const r = gitTry(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (r.ok && r.out) {
      const pretty = ref.startsWith('refs/remotes/') ? `origin/${branch}` : `${branch} (local)`;
      return { branch, ref: pretty, sha: r.out };
    }
  }
  return { error: `${input.raw}: no such branch — tried origin/${branch} and ${branch}` };
}

/** Tracked paths that git's own ignore rules would exclude, at one commit. */
function trackedIgnored(cwd) {
  const r = gitTry(['ls-files', '--cached', '--ignored', '--exclude-standard'], { cwd });
  return r.ok && r.out ? r.out.split('\n').filter(Boolean) : [];
}

function removeWorktree(path, branch) {
  gitTry(['worktree', 'remove', '--force', path]);
  if (existsSync(path)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* reported by the caller's message; nothing here can fix it */
    }
  }
  gitTry(['worktree', 'prune']);
  if (branch) gitTry(['branch', '-D', branch]);
}

function main() {
  const { help, errors, inputs, options } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(HELP);
    return EXIT_CODES.OK;
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`integration-merge: ${e}`);
    console.error('');
    process.stderr.write(HELP);
    return EXIT_CODES.USAGE;
  }

  const hasGh = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!hasGh && inputs.some((i) => i.kind === 'pr')) {
    console.error('integration-merge: `gh` is not available, so PR numbers cannot be resolved.');
  }

  if (options.fetch) {
    console.log('› git fetch origin (the base must be the CURRENT origin/main)');
    const f = gitTry(['fetch', 'origin', '--prune']);
    if (!f.ok) console.error(`integration-merge: fetch failed, continuing with local refs — ${f.out}`);
  }

  const baseSha = gitTry(['rev-parse', '--verify', `${options.base}^{commit}`]);
  if (!baseSha.ok) {
    console.error(`integration-merge: base ${options.base} does not resolve`);
    return EXIT_CODES.RESOLVE;
  }
  const base = { ref: options.base, sha: baseSha.out };

  const resolved = [];
  const unresolved = [];
  for (const input of inputs) {
    const r = resolveInput(input, { hasGh });
    if (r.error) {
      console.error(`integration-merge: ${r.error}`);
      unresolved.push(input.raw);
    } else resolved.push(r);
  }
  if (unresolved.length > 0) {
    const verdict = classifyRun({ unresolved });
    console.log('');
    console.log(formatSummary({ base, order: [], merges: [], gate: null, verdict, unresolved }));
    return verdict.exitCode;
  }

  const { unique: order, duplicates } = dedupeResolved(resolved);

  // The worktree name is a hash of what is being integrated, so a re-run of the
  // same set reuses the same name (and any stale copy is removed below) while
  // two different sets can be in flight at once. Deriving it from the clock
  // would make the same question produce a different answer's worth of paths.
  const id = createHash('sha256')
    .update([base.sha, ...order.map((o) => o.sha)].join('\n'))
    .digest('hex')
    .slice(0, 12);
  const worktree = join(tmpdir(), `olv-integration-${id}`);
  const branchName = `integration/${id}`;

  if (resolve(process.cwd()) === resolve(worktree)) {
    console.error('integration-merge: refusing to run from inside the scratch worktree');
    return EXIT_CODES.USAGE;
  }

  // A leftover from an earlier --keep run of the SAME set would otherwise make
  // `worktree add` fail on a path that is already registered.
  if (existsSync(worktree) || gitTry(['worktree', 'list', '--porcelain']).out.includes(worktree)) {
    console.log(`› removing a leftover scratch worktree at ${worktree}`);
    removeWorktree(worktree, branchName);
  }

  const add = gitTry(['worktree', 'add', '--quiet', '-b', branchName, worktree, base.sha]);
  if (!add.ok) {
    console.error(`integration-merge: could not create the scratch worktree — ${add.out}`);
    return EXIT_CODES.RESOLVE;
  }
  console.log(`› scratch worktree ${worktree} on ${branchName} at ${short(base.sha)}`);

  const merges = [];
  let gate = null;
  let ignored = { added: [], baseline: trackedIgnored(REPO_ROOT) };

  try {
    // A fresh worktree has no node_modules, and every gate command is an npm
    // script. Symlinking the caller's install keeps the run to seconds of setup
    // instead of an `npm ci`; the dependency tree is the same tree the caller
    // would gate against, which is the tree in question.
    const rootModules = join(REPO_ROOT, 'node_modules');
    const wtModules = join(worktree, 'node_modules');
    if (!existsSync(wtModules) && existsSync(rootModules)) {
      // The caller's own node_modules may already be a symlink (worktree
      // checkouts commonly borrow the main clone's install). Point at the real
      // directory so the scratch link does not depend on that one surviving.
      const target = lstatSync(rootModules).isSymbolicLink() ? realpathSync(rootModules) : rootModules;
      symlinkSync(target, wtModules, 'dir');
      console.log('› node_modules symlinked from the caller\'s install');
    } else if (!existsSync(rootModules)) {
      console.error('integration-merge: no node_modules to borrow; the gate will need its own install');
    }

    // Merge commits are dated from the base commit rather than "now", so the
    // same set of branches produces byte-identical merge commits on every run.
    const dateEnv = { GIT_AUTHOR_DATE: '', GIT_COMMITTER_DATE: '' };
    const baseDate = gitTry(['show', '-s', '--format=%cI', base.sha]);
    if (baseDate.ok) {
      dateEnv.GIT_AUTHOR_DATE = baseDate.out;
      dateEnv.GIT_COMMITTER_DATE = baseDate.out;
    }

    for (const item of order) {
      const already = gitTry(['merge-base', '--is-ancestor', item.sha, 'HEAD'], { cwd: worktree });
      if (already.ok) {
        console.log(`› ${item.branch} is already contained in the base`);
        merges.push({ branch: item.branch, sha: item.sha, status: 'already-merged', conflicts: [] });
        continue;
      }
      const m = gitTry(
        [
          // A fixed identity, not the operator's: a CI runner has no configured
          // user and `git merge` refuses to commit without one, and pinning it
          // alongside the date makes the merge commits themselves identical on
          // every machine. These commits are discarded, so they describe the
          // tool rather than a person.
          ...MERGE_IDENTITY,
          'merge',
          '--no-ff',
          '--no-edit',
          '-m',
          `integration: merge ${item.branch}`,
          item.sha,
        ],
        { cwd: worktree, env: dateEnv },
      );
      if (m.ok) {
        console.log(`› merged ${item.branch} @ ${short(item.sha)} cleanly`);
        merges.push({ branch: item.branch, sha: item.sha, status: 'clean', conflicts: [] });
        continue;
      }
      const conflicts = (gitTry(['diff', '--name-only', '--diff-filter=U'], { cwd: worktree }).out || '')
        .split('\n')
        .filter(Boolean);
      // Abort rather than leave a conflicted index: a half-merged worktree makes
      // every later reading (gate, ignored files) describe a tree that is not a
      // merge of anything.
      gitTry(['merge', '--abort'], { cwd: worktree });
      console.error(`› CONFLICT merging ${item.branch} @ ${short(item.sha)} — ${conflicts.length} file(s)`);
      for (const f of conflicts) console.error(`    ${f}`);
      merges.push({ branch: item.branch, sha: item.sha, status: 'conflict', conflicts });
      console.error('› refusing to continue: a conflict must be resolved on the branch, not here');
      break;
    }

    const conflicted = merges.some((m) => m.status === 'conflict');

    if (!conflicted) {
      // Tracked-but-ignored files, measured as a DELTA against the base. The
      // absolute set is not zero on this repository and is not even stable
      // across platforms: `.gitignore`'s `*AUDIT*.md` pattern matches a tracked
      // terrain-audit note under docs/_audit/ only where core.ignorecase is on,
      // so a macOS operator sees one pre-existing hit and Linux CI sees none.
      // Reporting that as a merge failure would train everyone to ignore this
      // check. --strict-ignored demands the absolute zero when that is wanted.
      const afterMerge = trackedIgnored(worktree);
      const baseline = new Set(ignored.baseline);
      ignored = {
        baseline: ignored.baseline,
        added: options.strictIgnored ? afterMerge : afterMerge.filter((f) => !baseline.has(f)),
      };

      if (options.runGate) {
        // The MERGED package.json decides which lints exist: a branch that adds
        // one is expected to have it run here, which is the whole point of
        // composing the quick gate instead of hard-coding it.
        const command = options.quick
          ? quickGateCommand(
              Object.keys(JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')).scripts ?? {}),
            )
          : options.gate;
        console.log('');
        console.log(`› gate: ${command}`);
        console.log('');
        const r = spawnSync(command, {
          cwd: worktree,
          shell: true,
          stdio: 'inherit',
          env: { ...process.env, OLV_INTEGRATION_MERGE: id },
        });
        gate = {
          command,
          // `status` is null when a signal killed the process; report that
          // instead of silently reading it as 0.
          exitCode: r.status === null ? 128 : r.status,
          signal: r.signal ?? null,
        };
      }
    }

    const verdict = classifyRun({ unresolved, merges, gate, addedIgnored: ignored.added });
    console.log('');
    console.log(
      formatSummary({
        base,
        order,
        merges,
        gate,
        ignored,
        verdict,
        duplicates,
        worktree: options.keep ? worktree : null,
      }),
    );
    if (options.keep) {
      console.log('');
      console.log(`kept for inspection: ${worktree}`);
      console.log(`clean up with: git worktree remove --force ${worktree} && git branch -D ${branchName}`);
    }
    return verdict.exitCode;
  } finally {
    // Cleanup runs on the failure paths too. The caller's checkout is never
    // touched by anything above: every mutation happens in the scratch worktree.
    if (!options.keep) removeWorktree(worktree, branchName);
  }
}

// Only the CLI path executes when this file is run; importing it for tests must
// not create worktrees.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
