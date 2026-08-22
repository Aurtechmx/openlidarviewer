/**
 * evidenceCommitNote.mjs — report which commit the evidence record describes.
 *
 * `lint-evidence.mjs` requires the recorded commit to be an ancestor of HEAD
 * only when `releaseAuthoritative` is true. A development record names the
 * branch tip it was generated on, which a squash merge replaces with a
 * different sha, so requiring ancestry there would fail by construction.
 *
 * The exemption is correct and it is also invisible: a record describing an
 * older commit and a record describing this exact checkout print the same
 * green line. This states the two commits, the channel, and the authoritative
 * flag, so a reader can tell "the evidence matches this checkout" from "the
 * lint did not look". It produces notes only. Nothing here fails a run.
 *
 * HEAD resolution degrades instead of throwing. The source archive is
 * extracted and verified outside any repository, and `verify-archive-portability`
 * refuses an extracted directory that carries a `.git` at all, so this code
 * runs where `rev-parse` has nothing to answer with.
 */

import { execFileSync } from 'node:child_process';

const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const short = (sha) => (isSha(sha) ? sha.slice(0, 7) : String(sha));

/**
 * The sha of HEAD, or null when it cannot be determined.
 *
 * Null covers every unavailable case as one: git missing from PATH, no
 * repository around the working directory, an unborn branch, a spawn that
 * fails. A shallow or detached checkout still answers `rev-parse HEAD`
 * normally and is not special-cased.
 *
 * `run` is injectable so the unavailable path is testable without removing
 * git from the machine.
 */
export function resolveHeadCommit({ gitPath, cwd, run } = {}) {
  const exec =
    run ??
    ((bin, args) =>
      execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  if (!gitPath) return null;
  try {
    const out = exec(gitPath, ['rev-parse', 'HEAD']);
    const sha = String(out ?? '').trim();
    return isSha(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * One note describing the recorded commit against `head`.
 *
 * `head` is a sha or null. The return value is always a string, never a
 * problem, and the caller must not derive an exit code from it.
 */
export function commitDriftNote({ evidence, head }) {
  const recorded = evidence?.commit ?? null;
  const channel = evidence?.releaseChannel ?? 'unknown';
  const authoritative = evidence?.releaseAuthoritative === true;
  // The two fields that make the ancestry exemption legitimate travel with
  // every variant of the note, including the ones that check nothing.
  const context = `releaseChannel ${channel}, releaseAuthoritative ${authoritative}`;

  if (!isSha(recorded)) {
    return `evidence records commit ${JSON.stringify(recorded)}, which is not a full sha (${context}); commit drift not checked.`;
  }
  if (head === null || head === undefined) {
    return (
      `evidence commit ${short(recorded)} (${recorded}); HEAD could not be resolved, so commit drift was not checked `
      + `(${context}). This is expected outside a git repository, such as an extracted source archive.`
    );
  }
  if (head === recorded) {
    return `evidence commit ${short(recorded)} equals HEAD ${short(head)} (${context}); the record describes this checkout.`;
  }
  return (
    `evidence commit ${short(recorded)} (${recorded}) differs from HEAD ${short(head)} (${head}) `
    + `(${context}); the record describes a different commit than this checkout.`
  );
}
