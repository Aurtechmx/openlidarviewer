import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `new URL(..., import.meta.url).pathname` is wrong for a filesystem path, and
 * wrong in a way that only shows up somewhere else.
 *
 * On a POSIX machine it returns exactly what `fileURLToPath` would, so a test
 * using it passes locally and in most of CI. On Windows it returns `/D:/a/...`,
 * and Node resolves that leading slash against the current drive, so a read
 * opens `D:\D:\a\...` and fails with ENOENT. The Windows leg caught one of
 * these; this catches the next one wherever it is written.
 *
 * Scoped to the unit bucket, which is the set that runs on the Windows leg. The
 * end-to-end specs run on other platforms and are not covered here.
 */
const TESTS = fileURLToPath(new URL('.', import.meta.url));

describe('no Windows path bug', () => {
  // This file is excluded from its own sweep: the case below holds the bad
  // pattern as a string so the matcher can be checked against it, and stripping
  // comments does not strip a literal.
  const unitFiles = readdirSync(TESTS)
    .filter((f) => f.endsWith('.test.ts'))
    .filter((f) => f !== 'noWindowsPathBug.test.ts');

  it('finds the unit bucket', () => {
    expect(unitFiles.length).toBeGreaterThan(50);
  });

  it('never derives a filesystem path from URL.pathname', () => {
    const offenders: string[] = [];
    for (const name of unitFiles) {
      const text = readFileSync(join(TESTS, name), 'utf8');
      // The comment in this file explains the pattern, so skip the explanation.
      const code = text.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/import\.meta\.url\s*\)\s*\.pathname/.test(code)) offenders.push(name);
      if (/new URL\([^)]*import\.meta\.url\s*\)\s*\.pathname/.test(code)) offenders.push(name);
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('matches the pattern it is guarding against', () => {
    const bad = "const SRC = new URL('../src/', import.meta.url).pathname;";
    const good = "const SRC = fileURLToPath(new URL('../src/', import.meta.url));";
    expect(/import\.meta\.url\s*\)\s*\.pathname/.test(bad)).toBe(true);
    expect(/import\.meta\.url\s*\)\s*\.pathname/.test(good)).toBe(false);
  });
});
