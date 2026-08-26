#!/usr/bin/env node
/**
 * pr-hygiene.mjs — structural guard for what a pull request shows a reviewer.
 *
 * A branch cut from another branch that is later SQUASH-merged replays history
 * forever. Squashing replaces N commits with one, so the originals never become
 * ancestors of `main` and keep reappearing in the child's review surface. One
 * PR here reached 103 commits and 56 files of which 48 were byte-identical to
 * main: eight files of real work behind forty-eight files of noise, and no gate
 * saw it.
 *
 * The diagnostic is `redundant`: a file in the three-dot review surface whose
 * content is identical between the base and the head. It is shown to a reviewer
 * for no reason. Zero is the normal value, including for a branch that is
 * merely behind.
 *
 * Two measurements are easy to confuse, and confusing them is how a stale but
 * healthy branch gets misread as a broken one:
 *
 *   surface = git diff --name-only BASE...HEAD   what review shows
 *   real    = git diff --name-only BASE   HEAD   how the trees differ NOW
 *
 * `real` counts main's newer files as differences, so it is large and
 * meaningless for any branch that is behind. Replay is judged by `redundant`
 * and merge commits, never by `real` alone.
 *
 * This lint hard-fails only on objective structure. Size is not incorrectness:
 * a generated validation record is large because the evidence is large, and a
 * wide refactor is wide because the change is wide. Those warn.
 *
 * Needs real history (`fetch-depth: 0`). Deliberately NOT part of the release
 * gate, which runs against an unpacked archive with no `.git`.
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Hard-fail once this many surface files are byte-identical to the base. */
export const REDUNDANT_LIMIT = 3;
/** Or once this share of the surface is, whichever trips first. */
export const REDUNDANT_SHARE = 0.2;
/** Surface this many times the real tree delta reads as replay, WITH redundancy. */
export const AMPLIFICATION = 2;
/** Above this many open non-draft PRs the queue is warned about, never failed. */
export const QUEUE_WARN = 8;
/** Commits behind the base before the branch is called stale. */
export const STALE_WARN = 40;
/** A surface this wide is noted so a reviewer can budget for it. */
export const WIDE_NOTE = 40;

const list = (files) =>
  files.slice(0, 10).join(', ') + (files.length > 10 ? `, and ${files.length - 10} more` : '');

/**
 * Problems in one observed branch. Pure: a function of what it is given, so the
 * cases in tests/prHygiene.test.ts construct histories rather than depending on
 * whatever the repository happens to contain today.
 *
 * observation = {
 *   baseRef, allowedBases, surface[], redundant[], realCount, mergeCommits[],
 *   linearHistoryRequired, commitsBehind, openPrCount, generatedFiles[]
 * }
 */

/**
 * Wording that describes how the change was produced rather than what it does.
 *
 * A pull request body and a commit message are read by people deciding whether
 * to trust and merge software. An account of the author's attempts, doubts or
 * instructions is noise there, and it survives in the permanent record long
 * after the session that produced it is gone. Nothing else in the pipeline
 * catches it: the prose gate looks for AI-writing tells and the archive gate
 * never reads a commit message at all.
 *
 * The patterns are deliberately narrow. A rule that fires on the word "I"
 * would be argued with and then disabled, which is worse than no rule, so
 * each one targets a construction that is hard to write by accident when
 * describing software.
 */
export const NARRATION_PATTERNS = [
  { id: 'first-person-process',
    // Allows up to two intervening adverbs ("I then quickly realised"), because
    // the construction is what matters and the adverb is incidental.
    re: /\b(?:I|we)\s+(?:\w+ly\s+|then\s+|first\s+|initially\s+|also\s+|originally\s+){0,2}(?:tried|realized|realised|noticed|decided|thought|discovered|found|started|began|went\s+with|opted|assumed|expected)\b/i,
    why: 'first-person process narration' },
  { id: 'deliberation', re: /(?:^|\n)\s*(?:Actually|Wait|Hmm|Let me|Let's see|On reflection|Turns out|It turns out)\b/i,
    why: 'thinking-aloud opener' },
  { id: 'instruction-echo', re: /\b(?:as\s+(?:you\s+)?(?:requested|asked)|per\s+your\s+(?:request|instruction)|the\s+user\s+(?:asked|wants|requested))\b/i,
    why: 'echo of the instruction that prompted the work' },
  { id: 'agent-self-reference', re: /\b(?:sub-?agents?|the\s+agent|Claude|Co-Authored-By|my\s+(?:analysis|reasoning|plan))\b/i,
    why: 'reference to the authoring process rather than the software' },
  { id: 'session-artifact', re: /\b(?:in\s+this\s+session|this\s+conversation|the\s+transcript|scratchpad|TODO|FIXME|XXX)\b/,
    why: 'working-note artifact' },
  { id: 'try-fail-narrative', re: /\b(?:at\s+first|initially,|my\s+first\s+attempt|that\s+did\s?n[o']t\s+work|second\s+attempt)\b/i,
    why: 'account of attempts rather than the result' },
];

/**
 * Find process narration in a body of authored text.
 *
 * Fenced code blocks and quoted lines are exempt: a diff, a log excerpt or a
 * quoted error legitimately contains any wording at all, and flagging those
 * would push authors to stop pasting the evidence that makes a PR reviewable.
 */
export function collectNarrationProblems(text, label = 'text') {
  if (!text) return [];
  const stripped = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const found = [];
  for (const { id, re, why } of NARRATION_PATTERNS) {
    const m = re.exec(stripped);
    if (m) found.push(`[H7 narration] ${label} contains ${why} ("${m[0].trim()}"). ` +
      'Say what the software does now, not how the change was arrived at.');
  }
  return found;
}

export function collectHygieneProblems(observation) {
  const {
    baseRef = 'main',
    allowedBases = ['main'],
    surface = [],
    redundant = [],
    realCount = 0,
    mergeCommits = [],
    linearHistoryRequired = true,
    commitsBehind = 0,
    openPrCount = 0,
    generatedFiles = [],
  } = observation;

  const errors = [];
  const warnings = [];

  if (!allowedBases.includes(baseRef)) {
    errors.push(
      `[H1 base-invalid] the PR targets '${baseRef}'; this repository merges into ` +
        `${allowedBases.map((b) => `'${b}'`).join(' or ')}. Retarget the PR.`,
    );
  }

  if (linearHistoryRequired && mergeCommits.length > 0) {
    errors.push(
      `[H2 merge-commit] ${mergeCommits.length} merge commit(s) on a branch where main ` +
        'requires linear history. Rebase onto current main rather than merging it in.',
    );
  }

  const share = surface.length > 0 ? redundant.length / surface.length : 0;
  if (redundant.length >= REDUNDANT_LIMIT || (redundant.length > 0 && share >= REDUNDANT_SHARE)) {
    errors.push(
      `[H3 redundant-surface] ${redundant.length} of ${surface.length} file(s) in the review ` +
        `surface are byte-identical to ${baseRef}: ${list(redundant)}. Those commits are already ` +
        'upstream, most often because this branch was cut from a branch that was later ' +
        'squash-merged. Rebase onto current main; do not add a waiver.',
    );
  } else if (redundant.length > 0) {
    warnings.push(
      `[W1 redundant-surface] ${redundant.length} file(s) in the review surface match ` +
        `${baseRef} exactly: ${list(redundant)}. Rebasing takes them out of review.`,
    );
  }

  if (realCount > 0 && surface.length > realCount * AMPLIFICATION && redundant.length > 0) {
    errors.push(
      `[H4 surface-amplified] review shows ${surface.length} file(s) but the trees differ in ` +
        `${realCount}, and ${redundant.length} surface file(s) are already upstream. The branch ` +
        'is replaying history. Rebase onto current main.',
    );
  }

  if (openPrCount > QUEUE_WARN) {
    warnings.push(
      `[W2 queue-depth] ${openPrCount} open non-draft PRs. Each merge invalidates the rest when ` +
        'the base requires branches to be up to date. This never blocks a merge.',
    );
  }

  if (commitsBehind > STALE_WARN) {
    warnings.push(
      `[W3 stale-base] ${commitsBehind} commit(s) behind ${baseRef}. Not a defect; it does mean ` +
        'review is reading against an old tree.',
    );
  }

  if (generatedFiles.length > 0) {
    warnings.push(
      `[W4 generated-record] ${generatedFiles.length} generated evidence file(s): ` +
        `${list(generatedFiles)}. Large because the evidence is large. Size is not scope.`,
    );
  }

  if (errors.length === 0 && surface.length > WIDE_NOTE && redundant.length === 0) {
    warnings.push(
      `[W5 wide-change] ${surface.length} file(s), none redundant. A wide change is not a ` +
        'malformed one; noted so a reviewer can budget for it.',
    );
  }

  return { errors, warnings };
}

const lines = (out) => (out ? out.split('\n').filter(Boolean) : []);

/**
 * Reads the observation this lint needs out of real history.
 *
 * `cwd` is a parameter rather than a constant so the cases in
 * tests/prHygiene.test.ts can build a repository with the history they are
 * about and read it with the same code CI runs.
 */
export function observeBranch(baseRef, headRef, extra = {}, cwd = ROOT) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const mergeBase = git('merge-base', baseRef, headRef);
  const surface = lines(git('diff', '--name-only', `${mergeBase}...${headRef}`));
  const realCount = lines(git('diff', '--name-only', baseRef, headRef)).length;
  const mergeCommits = lines(git('log', '--oneline', '--merges', `${mergeBase}..${headRef}`));
  const commitsBehind = lines(git('rev-list', `${mergeBase}..${baseRef}`)).length;

  const redundant = surface.filter((file) => {
    try {
      git('diff', '--quiet', baseRef, headRef, '--', file);
      return true;
    } catch {
      return false;
    }
  });

  return { baseRef, surface, redundant, realCount, mergeCommits, commitsBehind, ...extra };
}

const isCli = isCliEntry(import.meta.url);

if (isCli) {
  const base = process.env.PR_BASE_REF ? `origin/${process.env.PR_BASE_REF}` : 'origin/main';
  const head = process.env.PR_HEAD_SHA || 'HEAD';
  const openPrCount = Number(process.env.PR_OPEN_COUNT || 0);

  const observation = observeBranch(base, head, { openPrCount, allowedBases: [base] });
  const { errors, warnings } = collectHygieneProblems(observation);

  // The authored text: the PR body, supplied by the workflow, and every commit
  // message on the branch. Both outlive the session that wrote them, so both
  // are checked. A missing PR_BODY means the check simply has less to read; it
  // is not treated as a pass or as a failure.
  errors.push(...collectNarrationProblems(process.env.PR_BODY ?? '', 'the PR body'));
  try {
    const mergeBase = execFileSync('git', ['merge-base', base, head], {
      cwd: ROOT, encoding: 'utf8',
    }).trim();
    const log = execFileSync('git', ['log', '--format=%B', `${mergeBase}..${head}`], {
      cwd: ROOT, encoding: 'utf8',
    });
    errors.push(...collectNarrationProblems(log, 'a commit message on this branch'));
  } catch {
    // No git history to read. The PR body check above still applies.
  }

  for (const w of warnings) console.log(`  note: ${w}`);

  if (errors.length > 0) {
    console.error(`\nlint:pr-hygiene: ${errors.length} problem(s):\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error('');
    process.exit(1);
  }

  console.log(
    `lint:pr-hygiene: OK — ${observation.surface.length} file(s) in review, ` +
      `${observation.redundant.length} redundant, ${observation.mergeCommits.length} merge commit(s), ` +
      `${observation.commitsBehind} commit(s) behind ${base}.`,
  );
}
