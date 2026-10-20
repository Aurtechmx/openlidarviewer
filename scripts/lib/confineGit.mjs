/**
 * confineGit.mjs — git answers for this project only.
 *
 * git looks for a repository in the working directory and then in every parent
 * directory. A source archive extracted below an unrelated checkout therefore
 * read that checkout's commit as its own build identity, and the checks that
 * read history (freeze claims, claim prose, control characters) read the
 * parent's files and failed. Setting GIT_CEILING_DIRECTORIES to the directory
 * above the project root stops the search there: git sees this project's own
 * `.git` (a directory, or a file in a worktree) or nothing.
 *
 * Importing this module applies the ceiling to the current process, which every
 * git child process inherits. The scripts that run git import it first; ES
 * module imports run before the importing script's own code.
 */
import { realpathSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project root: two levels above scripts/lib/. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The ceiling for `root`: the real path of the directory that contains it. */
export function gitCeilingFor(root) {
  return dirname(realpathSync(root));
}

/**
 * Stop git's repository search above `root` for this process and its children.
 * Keeps any ceilings already set. Returns the ceiling added.
 */
export function confineGitToProject(root = PROJECT_ROOT, env = process.env) {
  const ceiling = gitCeilingFor(root);
  const existing = (env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter).filter(Boolean);
  if (!existing.includes(ceiling)) env.GIT_CEILING_DIRECTORIES = [ceiling, ...existing].join(delimiter);
  return ceiling;
}

confineGitToProject();
