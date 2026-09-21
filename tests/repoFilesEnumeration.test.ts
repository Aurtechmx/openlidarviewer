/**
 * repoFilesEnumeration.test.ts — the file enumerator must never scan nothing.
 *
 * `distributedFiles()` backs the curated-licence check, the tool-path check
 * and the packaging repro. All three assert that something "appears somewhere
 * in the tree", so an enumeration that returns an EMPTY list does not make
 * them skip — it makes every one of them fail, with a message about the data
 * rather than about the scan.
 *
 * That is exactly what happened. Stryker copies the tree into
 * `.stryker-tmp/sandbox-*`, which sits inside the work tree and is
 * `.gitignore`d, so `git ls-files` there exits 0 with no output. It fails by
 * SUCCEEDING, so the `catch` that guards the archive case never fired, and the
 * mutation job's initial dry run reported twelve curated licence URLs as
 * "appearing nowhere else" while every one of those files sat in the sandbox.
 *
 * This is the assertion that would have named the cause in one line.
 */

import { describe, it, expect } from 'vitest';

import { distributedFiles } from './helpers/repoFiles';

describe('the distributed-file enumeration', () => {
  const files = distributedFiles();

  it('describes a non-empty tree', () => {
    // A zero-file answer is never true of this repository, so it means the
    // enumeration went blind — in a git sandbox, an odd checkout, anywhere.
    expect(files.length).toBeGreaterThan(100);
  });

  it('includes files the other scans depend on finding', () => {
    // Named rather than counted: a scan that returns SOME files but not these
    // would let the licence and tool-path checks fail for the same wrong
    // reason, one step less obviously.
    for (const f of ['package.json', 'docs/credits.md', 'src/main.ts']) {
      expect(files, f).toContain(f);
    }
  });

  it('returns repo-root-relative POSIX paths, not absolute ones', () => {
    for (const f of files.slice(0, 200)) {
      expect(f.startsWith('/'), f).toBe(false);
      expect(f.includes('\\'), f).toBe(false);
    }
  });
});
