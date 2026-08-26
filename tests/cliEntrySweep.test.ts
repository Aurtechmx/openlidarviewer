/**
 * cliEntrySweep.test.ts — no script may hand-roll its own CLI-entry check.
 *
 * Every form the tree carried compared a path the caller typed against one the
 * ESM loader had already resolved, so invoking a script through a symlink made
 * the comparison false and the body never ran. The process still exited 0 with
 * no output, which reads as a clean pass. Five spellings of that bug existed at
 * once, so pinning the shared helper is not enough: a new script written in any
 * of them would reintroduce it silently.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'lib/isCliEntry.mjs';

function scriptFiles(dir: string, prefix = ''): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? scriptFiles(`${dir}/${e.name}`, `${prefix}${e.name}/`)
      : e.name.endsWith('.mjs')
        ? [`${prefix}${e.name}`]
        : [],
  );
}

describe('CLI-entry detection', () => {
  const files = scriptFiles('scripts');

  it('finds the scripts to check', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('is never hand-rolled from process.argv[1]', () => {
    const offenders = files.filter((f) => {
      if (f === HELPER) return false;
      return readFileSync(resolve(ROOT, 'scripts', f), 'utf8').includes('process.argv[1]');
    });
    expect(
      offenders,
      'these read process.argv[1] directly. Import isCliEntry from lib/isCliEntry.mjs: ' +
        'a comparison against an unresolved argv[1] silently skips the CLI body ' +
        'when the script is reached through a symlink, and still exits 0.',
    ).toEqual([]);
  });
});
