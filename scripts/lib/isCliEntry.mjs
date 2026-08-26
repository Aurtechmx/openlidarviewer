/**
 * isCliEntry.mjs — decide whether this module is the program Node was asked to run.
 *
 * The usual form of that check compares two paths:
 *
 *   resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
 *
 * Those two sides are not produced the same way. `import.meta.url` comes from
 * the ESM loader, which has already followed every symlink on the way to the
 * file, so it always names the real path. `process.argv[1]` is whatever the
 * caller typed. Invoke a script through a path that crosses a symlink — a
 * checkout linked from elsewhere, a tool that hands Node a link — and the two
 * strings differ, the comparison is false, and the CLI body never runs.
 *
 * The failure is silent and reads as success: no output, exit 0. A guard that
 * exits 0 without running is worse than one that crashes, because a caller
 * cannot tell it apart from a clean pass.
 *
 * So both sides are compared after realpathSync, which resolves symlinks the
 * same way the loader does. Anything that cannot be resolved on disk falls back
 * to resolve(), so a deleted or synthetic argv[1] gives a plain false instead of
 * throwing out of a module's top level.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Real path of `p`, or its resolved form when it does not exist on disk. */
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Whether `moduleUrl` (pass `import.meta.url`) is the entry Node was started
 * with. False when Node was given no script at all, as in `node -e` or a REPL.
 *
 * `argv1` is injectable so the comparison itself can be tested without spawning
 * a process.
 */
export function isCliEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return realOrResolved(argv1) === realOrResolved(fileURLToPath(moduleUrl));
}
