/**
 * A fingerprint of the working tree, used to prove a test run left it as it
 * found it. It records `git status --porcelain` (which lists untracked files)
 * and a hash of `git diff HEAD`, so a probe document, an edited tracked file and
 * an edit to an already-modified file all change it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { binaryOnPath } from '../../scripts/lib/binaryOnPath.mjs';

/** git resolved to an absolute path once, as in tests/helpers/repoFiles.ts. */
const GIT: string | null = binaryOnPath('git');

export interface TreeSnapshot {
  status: string;
  diffHash: string;
}

/** The tree's fingerprint, or null when `root` is not inside a git checkout. */
export function snapshotTree(root: string): TreeSnapshot | null {
  if (!GIT) return null;
  const gitPath = GIT;
  const git = (...args: string[]) => spawnSync(gitPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 });
  const status = git('status', '--porcelain', '--untracked-files=all');
  if (status.status !== 0) return null;
  const diff = git('diff', 'HEAD', '--binary');
  if (diff.status !== 0) return null;
  return { status: status.stdout, diffHash: createHash('sha256').update(diff.stdout).digest('hex') };
}

/** A message naming what changed, or null when the two fingerprints match. */
export function describeTreeChange(before: TreeSnapshot, after: TreeSnapshot): string | null {
  if (before.status === after.status && before.diffHash === after.diffHash) return null;
  const was = new Set(before.status.split('\n').filter(Boolean));
  const now = after.status.split('\n').filter(Boolean);
  const added = now.filter((l) => !was.has(l));
  const removed = [...was].filter((l) => !now.includes(l));
  const lines = ['The test run changed the working tree.'];
  if (added.length) lines.push('New or changed entries:', ...added.map((l) => `  ${l}`));
  if (removed.length) lines.push('Entries no longer present:', ...removed.map((l) => `  ${l}`));
  if (!added.length && !removed.length) lines.push('A file that was already modified was edited again (git diff HEAD changed).');
  return lines.join('\n');
}
