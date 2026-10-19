/**
 * repoOnlyDocs.mjs: which tree is this, and what may it be missing.
 *
 * Two internal development documents live in the repository and are
 * export-ignored from the source archive (.gitattributes):
 *
 *   docs/releases/V070_IMPLEMENTATION_LEDGER.md
 *   docs/releases/V070_CURRENT_STATUS.md   (generated from the ledger)
 *
 * A check that reads them has to tell two situations apart that look the same
 * on disk, because they must be handled in opposite ways:
 *
 *   - a git checkout: the files are tracked, so a missing one is a real error
 *     (deleted, misnamed, never committed) and the check fails;
 *   - an extracted source archive: the files are absent by design, so the
 *     check has nothing to read, says so out loud, and passes.
 *
 * The test is the same one the archive-portability check uses to refuse an
 * archive: a `.git` entry at the root (a directory in a clone, a file in a
 * linked worktree). It is looked for at the root of THIS tree rather than asked
 * of `git rev-parse`, which would answer yes for an archive that happens to be
 * extracted somewhere inside another repository, and would need git installed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const LEDGER_PATH = 'docs/releases/V070_IMPLEMENTATION_LEDGER.md';
export const STATUS_PATH = 'docs/releases/V070_CURRENT_STATUS.md';

/** True when `root` is a git checkout, false for an extracted source archive. */
export function isGitCheckout(root) {
  return existsSync(join(root, '.git'));
}

/**
 * The line printed when a check is skipped because the ledger is not shipped.
 * One wording, so a reader of a gate log sees the same sentence from each check.
 */
export function ledgerSkipNotice(check) {
  return `${check}: SKIPPED. This is a source archive (no .git) and ${LEDGER_PATH} is not shipped in it; ` +
    'the checks that read it run in the git checkout.';
}
