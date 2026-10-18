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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Where the step logs go, relative to the repository root. */
export const DEFAULT_STEP_LOG_DIR = 'release/gate-steps';

/** A step's log file name: the npm script name with path-unsafe characters replaced (`test:unit` becomes `test_unit.log`). */
export function stepLogName(script) {
  return `${String(script).replace(/[^A-Za-z0-9._-]+/g, '_')}.log`;
}

/** Empty (or create) the log directory before a run. */
export function prepareStepLogDir(dir) {
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
