/**
 * vitestFileList.test.ts — a bucket's test files never ride on the command line.
 *
 * Windows' CreateProcess limits a whole command line to 32,767 characters, and
 * the unit bucket's file list alone grew past that. The shard command is now
 * built without the files, which reach vitest through a list file instead.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILE_LIST_ENV,
  WINDOWS_COMMAND_LINE_LIMIT,
  commandLineLength,
  readFileList,
  vitestRunArgs,
  writeFileList,
} from '../scripts/lib/vitestFileList.mjs';

const WINDOWS_NODE = 'C:\\hostedtoolcache\\windows\\node\\22.20.0\\x64\\node.exe';
const WINDOWS_ENTRY = 'D:\\a\\openlidarviewer\\openlidarviewer\\node_modules\\vitest\\vitest.mjs';

/** 3,000 long test paths, well past the limit if they were arguments. */
const MANY = Array.from({ length: 3000 }, (_, i) => `tests/aVeryLongDescriptiveTestFileNameNumber${i}ForTheUnitBucket.test.ts`);

describe('the shard command line', () => {
  it('stays under the CreateProcess limit with 3,000 long test paths', () => {
    const args = vitestRunArgs({
      prefix: [WINDOWS_ENTRY],
      bucketArgs: ['--maxWorkers=2'],
      extra: ['--shard=1/3'],
      passthrough: [],
      tallyFile: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\olv-tally-unit-1234-0.json',
    });
    for (const f of MANY) expect(args).not.toContain(f);
    expect(commandLineLength(WINDOWS_NODE, args)).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
    // The same files as arguments would not fit, which is the failure this fixes.
    expect(commandLineLength(WINDOWS_NODE, [...args, ...MANY])).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT);
  });

  it('keeps the run, shard and reporter arguments in order', () => {
    expect(vitestRunArgs({ prefix: ['entry'], bucketArgs: ['--maxWorkers=2'], extra: ['--shard=2/3'], passthrough: ['--bail=1'], tallyFile: 't.json' }))
      .toEqual(['entry', 'run', '--maxWorkers=2', '--shard=2/3', '--bail=1', '--reporter=default', '--reporter=json', '--outputFile.json=t.json']);
  });
});

describe('the list file', () => {
  it('round-trips the exact file list through the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olv-list-'));
    try {
      const path = join(dir, 'files.json');
      writeFileList(path, MANY);
      expect(readFileList({ [FILE_LIST_ENV]: path })).toEqual(MANY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no list is named, and throws on a malformed one', () => {
    expect(readFileList({})).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'olv-list-'));
    try {
      const path = join(dir, 'bad.json');
      writeFileSync(path, JSON.stringify({ not: 'a list' }));
      expect(() => readFileList({ [FILE_LIST_ENV]: path })).toThrow(/does not hold a list of test files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
