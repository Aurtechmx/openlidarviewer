/**
 * currentReleaseDocsSync.test.ts — the current release's documents are named by
 * version in three places: the prose-sync scan list, the docs/README.md index,
 * and REPRODUCIBILITY.md. Each was hard-coded to a literal version, so the
 * moment the version rolled the scan stopped covering the shipping report and
 * the index pointed a "current release" label at the prior one. These tests
 * bind all three to package.json so a version bump cannot leave them behind.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs lint script, no types
import { TRUTH_DOCS, PKG_VERSION } from '../scripts/lint-claim-prose-sync.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const V = PKG_VERSION as string;
const CURRENT_TRIO = [
  `docs/releases/RELEASE_NOTES_v${V}.md`,
  `docs/releases/VALIDATION_REPORT_v${V}.md`,
  `docs/releases/KNOWN_LIMITATIONS_v${V}.md`,
];

describe('the current release documents track the package version', () => {
  it('the prose-sync scan derives the current trio from package.json', () => {
    for (const doc of CURRENT_TRIO) {
      expect(TRUTH_DOCS, `TRUTH_DOCS is missing ${doc}`).toContain(doc);
      expect(existsSync(resolve(ROOT, doc)), `${doc} does not exist`).toBe(true);
    }
  });

  it('every "current release" link in docs/README.md names the version', () => {
    const stale = read('docs/README.md')
      .split('\n')
      .filter((l) => /current release|behind that release/i.test(l))
      .filter((l) => /releases\/\w+_v[\d.]+\.md/.test(l))
      .filter((l) => !l.includes(`_v${V}.md`));
    expect(stale).toEqual([]);
  });

  it('REPRODUCIBILITY.md points its current-release reference at the version', () => {
    const stale = read('REPRODUCIBILITY.md')
      .split('\n')
      .filter((l) => /current release|for a tagged release/i.test(l))
      .filter((l) => /releases\/\w+_v[\d.]+\.md/.test(l))
      .filter((l) => !l.includes(`_v${V}.md`));
    expect(stale).toEqual([]);
  });
});
