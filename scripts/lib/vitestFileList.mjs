/**
 * vitestFileList.mjs — hand a bucket's test files to vitest without the
 * command line.
 *
 * test-bucket.mjs used to pass every file of a bucket as an argument. The unit
 * bucket holds about a thousand files, and the argument vector grew past the
 * 32,767-character limit Windows' CreateProcess puts on a whole command line,
 * so the Windows job failed with `spawn ENAMETOOLONG` before a test ran.
 *
 * The list now goes through a JSON file named by an environment variable, and
 * vitest.config.ts uses it as `test.include`. vitest resolves the same set of
 * files either way, so `--shard=i/N` slices it the same way.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** The environment variable that names the file list. */
export const FILE_LIST_ENV = 'OLV_VITEST_FILE_LIST';

/** CreateProcess's limit on the whole command line, in characters. */
export const WINDOWS_COMMAND_LINE_LIMIT = 32767;

/** Write `files` (repo-relative paths) to `path` as JSON. */
export function writeFileList(path, files) {
  writeFileSync(path, JSON.stringify(files));
}

/**
 * The file list named by the environment, or null when none is set. Throws
 * when the variable names a file that is missing or does not hold an array of
 * strings, so a broken hand-off fails loudly instead of running every test.
 */
export function readFileList(env = process.env) {
  const path = env[FILE_LIST_ENV];
  if (!path) return null;
  const list = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(list) || !list.every((f) => typeof f === 'string')) {
    throw new Error(`${FILE_LIST_ENV}: ${path} does not hold a list of test files`);
  }
  return list;
}

/**
 * The vitest arguments for one shard run. The test files are not among them.
 * `prefix` is what precedes `run` (the vitest entry module on Windows).
 */
export function vitestRunArgs({ prefix = [], bucketArgs = [], extra = [], passthrough = [], tallyFile }) {
  return [
    ...prefix,
    'run', ...bucketArgs, ...extra, ...passthrough,
    // default keeps the human console output; json feeds the file the parent
    // reads for the GATE TALLY line.
    '--reporter=default', '--reporter=json', `--outputFile.json=${tallyFile}`,
  ];
}

/**
 * Length of the command line CreateProcess receives for `command` and `args`:
 * each element quoted and separated by a space. An upper bound for checking
 * against {@link WINDOWS_COMMAND_LINE_LIMIT}.
 */
export function commandLineLength(command, args) {
  return [command, ...args].reduce((n, a) => n + a.length + 3, 0);
}
