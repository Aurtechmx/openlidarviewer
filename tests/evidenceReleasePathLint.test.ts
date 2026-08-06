/**
 * evidenceReleasePathLint.test.ts — proves scripts/lint-evidence.mjs actually
 * parses the versioned release documents under docs/releases/.
 *
 * The four truth documents moved from the repository root to docs/releases/ in
 * the v0.6.4 cycle. lint-evidence still built root paths, so a wrong test count
 * inside a real release document was invisible: the path did not exist, the
 * loop's `existsSync → continue` skipped it, and the guard fell back to a
 * different file. This writes a false bucket total into the real release
 * document and requires the lint to refuse it, so the path can never silently
 * drift back to the root.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs helper, no types
import { releaseDocsFor } from '../scripts/lib/releaseDocs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version as string;
const evidence = JSON.parse(readFileSync(resolve(ROOT, 'docs/validation/test-evidence.json'), 'utf8'));

const runLint = () =>
  spawnSync('node', ['scripts/lint-evidence.mjs'], { cwd: ROOT, encoding: 'utf8' });

describe('lint:evidence release-doc path', () => {
  it('passes on the real, correct tree', () => {
    expect(runLint().status).toBe(0);
  });

  it('refuses a false bucket total written into a real release document', () => {
    // The validation report is one of the four versioned docs under docs/releases/.
    const doc = releaseDocsFor(VERSION).validationReport as string;
    const abs = resolve(ROOT, doc);
    const original = readFileSync(abs, 'utf8');
    // A bucket count that cannot be the real one (real unit passed is thousands).
    const bucket = Object.keys(evidence.buckets)[0];
    try {
      writeFileSync(abs, `${original}\n${bucket} 1 passed\n`);
      const r = runLint();
      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toContain(doc);
    } finally {
      writeFileSync(abs, original);
    }
    // The tree is restored, so a follow-up run is green again.
    expect(runLint().status).toBe(0);
  });
});
