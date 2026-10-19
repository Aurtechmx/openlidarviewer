/**
 * scripts/lib/gateStepLogs.mjs: the full output of each step of
 * scripts/run-gates.mjs, one file per step.
 *
 * The runner prints only the last lines of a failed step, which cuts off the
 * first error of a long test or lint run. Every step's whole output is written
 * to `<dir>/<step>.log` (default `release/gate-steps/`), and the summary of a
 * failed step names its file beside the tail.
 *
 * `release/` is git-ignored, and nothing under it is packaged except the files
 * the release workflow copies by name (the gate log, evidence, zips and notes),
 * so these logs never reach the deploy or source archive. The directory is
 * emptied at the start of each run, so its files always describe the last run.
 */

import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the step logs go, relative to the repository root. */
export const DEFAULT_STEP_LOG_DIR = 'release/gate-steps';

/** A step's log file name: the npm script name with path-unsafe characters replaced (`test:unit` becomes `test_unit.log`). */
export function stepLogName(script) {
  return `${String(script).replace(/[^A-Za-z0-9._-]+/g, '_')}.log`;
}

/** A path with symlinks resolved as far as it exists, so a link cannot point the check somewhere else. */
function resolvedPath(p) {
  const abs = resolve(p);
  let existing = abs;
  const tail = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    tail.unshift(existing.slice(dirname(existing).length + 1));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...tail);
}

/**
 * Throw unless `dir` is a directory the runner may empty: strictly inside the
 * repository's `release/` directory. `OLV_GATE_STEP_LOG_DIR` moves the logs,
 * and the runner deletes whatever it names, so a value that is the repository
 * root, one of its ancestors, `release/` itself or anything outside `release/`
 * is refused rather than wiped.
 */
export function assertStepLogDirSafe(dir, root = REPO_ROOT) {
  const target = resolvedPath(dir);
  const release = resolvedPath(join(root, 'release'));
  const rel = relative(release, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Refusing to empty ${target} as the gate step log directory: it must be a directory inside ${release}. ` +
        'Unset OLV_GATE_STEP_LOG_DIR, or point it at a folder under release/.',
    );
  }
}

/** Empty (or create) the log directory before a run. Refuses a directory outside release/. */
export function prepareStepLogDir(dir, root = REPO_ROOT) {
  assertStepLogDirSafe(dir, root);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/** Write one step's whole output; returns the file path. */
export function writeStepLog(dir, script, output) {
  const path = join(dir, stepLogName(script));
  writeFileSync(path, output);
  return path;
}

/**
 * The summary block of a step that did not pass: its outcome, the last
 * `tailLines` lines of its output, and the path of its full log when one was
 * written (a skipped step ran nothing and has none).
 */
export function failureBlock({ script, skipped, code, output, logPath, root, tailLines }) {
  const head = `==== ${script}: ${skipped ? 'skipped' : `exit ${code}`} ====`;
  const tail = String(output ?? '').trimEnd().split('\n').slice(-tailLines).join('\n');
  const where = logPath ? `\n---- full output: ${root ? relative(root, logPath) : logPath}` : '';
  return `\n${head}\n${tail}${where}`;
}
