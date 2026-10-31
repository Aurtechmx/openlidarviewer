/**
 * evidenceReleasePathLint.test.ts — proves scripts/lint-evidence.mjs actually
 * parses the versioned release documents under docs/releases/.
 *
 * The four truth documents moved from the repository root to docs/releases/ in
 * the v0.6.4 cycle. lint-evidence still built root paths, so a wrong test count
 * inside a real release document was invisible: the path did not exist, the
 * loop's `existsSync → continue` skipped it, and the guard fell back to a
 * different file. This writes a false bucket total into the release document
 * and requires the lint to refuse it, so the path can never silently drift
 * back to the root.
 *
 * The fault goes into a copy of the release documents, laid out at the same
 * repo-relative paths and handed to the lint with --doc-root, so a gate
 * running beside this test never reads a corrupted document.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs helper, no types
import { releaseDocsFor } from '../scripts/lib/releaseDocs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version as string;
const evidence = JSON.parse(readFileSync(resolve(ROOT, 'docs/validation/test-evidence.json'), 'utf8'));

const runLint = (docRoot: string) =>
  spawnSync('node', ['scripts/lint-evidence.mjs', '--doc-root', docRoot], { cwd: ROOT, encoding: 'utf8' });

/** Copy the release documents the lint reads into a fresh directory at the same relative paths. */
function copyReleaseDocs(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'olv-release-docs-'));
  const docs = releaseDocsFor(VERSION) as Record<string, string>;
  for (const rel of [...Object.values(docs), `READINESS_REPORT_v${VERSION}.md`, 'ARTIFACT_EVALUATION.md']) {
    const src = resolve(ROOT, rel);
    if (!existsSync(src)) continue;
    mkdirSync(dirname(resolve(dir, rel)), { recursive: true });
    cpSync(src, resolve(dir, rel));
  }
  return dir;
}

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
    const committed = readFileSync(resolve(ROOT, doc), 'utf8');
    // A bucket count that cannot be the real one (real unit passed is thousands).
    const bucket = Object.keys(evidence.buckets)[0];
    const dir = copyReleaseDocs();
    try {
      const before = runLint(dir);
      expect(before.stderr + before.stdout).not.toContain(doc);

      writeFileSync(resolve(dir, doc), `${committed}\n${bucket} 1 passed\n`);
      const during = runLint(dir);
      expect(during.status).not.toBe(0);
      expect(during.stderr + during.stdout).toContain(doc);

      // Removing the fault removes the complaint, and the verdict returns to
      // whatever the tree's own state was.
      writeFileSync(resolve(dir, doc), committed);
      const after = runLint(dir);
      expect(after.stderr + after.stdout).not.toContain(doc);
      expect(after.status).toBe(before.status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The committed document is never written.
    expect(readFileSync(resolve(ROOT, doc), 'utf8')).toBe(committed);
  });
});
