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
  it('names the release document only while a false bucket total is in it', () => {
    // The guard is that the lint reads the versioned docs under docs/releases/
    // rather than the root paths they moved from. Injecting a fault and
    // watching the document appear in the output proves the path is read, and
    // holds whether or not the tree is otherwise green: between a dependency
    // change and the next "npm run evidence" the lint legitimately fails for an
    // unrelated reason, and this test runs inside the gate that regeneration
    // waits on.
    const doc = releaseDocsFor(VERSION).validationReport as string;
    const abs = resolve(ROOT, doc);
    const original = readFileSync(abs, 'utf8');
    // A bucket count that cannot be the real one (real unit passed is thousands).
    const bucket = Object.keys(evidence.buckets)[0];

    const before = runLint();
    expect(before.stderr + before.stdout).not.toContain(doc);

    let during;
    try {
      writeFileSync(abs, `${original}\n${bucket} 1 passed\n`);
      during = runLint();
    } finally {
      writeFileSync(abs, original);
    }
    expect(during.status).not.toBe(0);
    expect(during.stderr + during.stdout).toContain(doc);

    // Removing the fault removes the complaint, and the verdict returns to
    // whatever the tree's own state was.
    const after = runLint();
    expect(after.stderr + after.stdout).not.toContain(doc);
    expect(after.status).toBe(before.status);
  });
});
