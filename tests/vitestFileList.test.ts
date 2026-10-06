/**
 * vitestFileList.test.ts — a bucket's test files never ride on the command line.
 *
 * Windows' CreateProcess limits a whole command line to 32,767 characters, and
 * the unit bucket's file list alone grew past that. The shard command is now
 * built without the files, which reach vitest through a list file instead.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
    const list = writeFileList(MANY);
    try {
      expect(readFileList({ [FILE_LIST_ENV]: list.path })).toEqual(MANY);
    } finally {
      list.dispose();
    }
  });

  it('creates the list exclusively, owner-only, inside its own mkdtemp directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'olv-parent-'));
    try {
      const list = writeFileList(['tests/a.test.ts'], parent);
      const dir = dirname(list.path);
      expect(dirname(dir)).toBe(parent);
      expect(basename(dir)).toMatch(/^olv-files-.{6}$/);
      if (process.platform !== 'win32') {
        expect(statSync(list.path).mode & 0o777).toBe(0o600);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
      // `wx`: a file already at that path is never overwritten.
      expect(() => writeFileSync(list.path, '[]', { flag: 'wx' })).toThrow(/EEXIST/);
      // Two lists never share a directory.
      const other = writeFileList([], parent);
      expect(dirname(other.path)).not.toBe(dir);
      list.dispose();
      other.dispose();
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('puts the tally file in the same private directory, owner-only and exclusive', () => {
    const parent = mkdtempSync(join(tmpdir(), 'olv-parent-'));
    try {
      const list = writeFileList(['tests/a.test.ts'], parent);
      expect(dirname(list.tallyPath)).toBe(dirname(list.path));
      expect(dirname(dirname(list.tallyPath))).toBe(parent);
      expect(basename(list.tallyPath)).not.toMatch(/pid|\d{3,}/);
      if (process.platform !== 'win32') {
        expect(statSync(list.tallyPath).mode & 0o777).toBe(0o600);
      }
      expect(() => writeFileSync(list.tallyPath, '{}', { flag: 'wx' })).toThrow(/EEXIST/);
      list.dispose();
      expect(existsSync(list.tallyPath)).toBe(false);
      expect(existsSync(dirname(list.tallyPath))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('test-bucket.mjs no longer builds a tally path in the shared temp directory', () => {
    const src = readFileSync(join(__dirname, '..', 'scripts', 'test-bucket.mjs'), 'utf8');
    expect(src).not.toMatch(/tmpdir\(/);
    expect(src).not.toMatch(/olv-tally-/);
    expect(src).toMatch(/list\.tallyPath/);
    expect(src).toMatch(/process\.on\('exit'/);
  });

  it('test-bucket.mjs exits through its cleanup hook on SIGINT and SIGTERM', () => {
    const src = readFileSync(join(__dirname, '..', 'scripts', 'test-bucket.mjs'), 'utf8');
    expect(src).toMatch(/process\.on\('SIGINT', \(\) => process\.exit\(130\)\)/);
    expect(src).toMatch(/process\.on\('SIGTERM', \(\) => process\.exit\(143\)\)/);
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
