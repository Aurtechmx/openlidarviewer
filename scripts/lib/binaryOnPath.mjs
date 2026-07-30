/**
 * binaryOnPath.mjs — resolve a program to an absolute path by reading PATH.
 *
 * Every script here spawns helpers by bare name: `git`, `node`, `tar`, `npm`.
 * Static analysis flags that, and the flag is not silly. A bare name is
 * resolved by the OS against whatever PATH happens to hold, so a writable
 * directory earlier in PATH decides which program runs.
 *
 * The obvious fix, hard-coding `/usr/bin/git`, is worse than the problem: it
 * breaks on every machine that installs it elsewhere, which is most of them.
 * Reading PATH and returning the absolute path of the entry that would have
 * run keeps the behaviour identical and makes the choice explicit and
 * inspectable.
 *
 * This is not a security boundary. Anyone who can write to a directory on your
 * PATH can already run code as you. What it does is remove the ambiguity: the
 * spawned path is a value the caller can log, compare or refuse.
 *
 * Windows is handled because contributors run these scripts there: PATH is
 * split on `;`, and PATHEXT suffixes are tried in order.
 */

import { accessSync, constants } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { platform } from 'node:process';

const WINDOWS = platform === 'win32';

/** Suffixes to try on Windows, where `git` on disk is `git.exe`. */
function suffixes() {
  if (!WINDOWS) return [''];
  const ext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return ['', ...ext.split(';').filter(Boolean)];
}

/**
 * The absolute path PATH would resolve `name` to, or null when nothing on PATH
 * is executable under that name.
 *
 * A name that already contains a separator is returned as an absolute path
 * without searching, because the caller has already said where to look.
 */
export function binaryOnPath(name, env = process.env) {
  if (name.includes('/') || (WINDOWS && name.includes('\\'))) return resolve(name);
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const suffix of suffixes()) {
      const candidate = resolve(dir, name + suffix);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here, or not executable. Keep looking.
      }
    }
  }
  return null;
}

/**
 * Like {@link binaryOnPath}, but throws instead of returning null.
 *
 * Callers that cannot proceed without the program get a message naming it,
 * rather than a spawn failure that says only ENOENT.
 */
export function requireBinaryOnPath(name, env = process.env) {
  const found = binaryOnPath(name, env);
  if (found === null) {
    throw new Error(`${name} was not found on PATH; this script cannot run without it.`);
  }
  return found;
}
