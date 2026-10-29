/**
 * standardsTruthLint.test.ts — proves lint:standards-truth refuses the
 * statements it exists to refuse, and lets the correct ones through.
 *
 * A standards lint is only worth having if it fails on a real contradiction. It
 * is only worth keeping if a correct sentence passes: the first version failed
 * on "23 to 63 are reserved, and only 64 and above are user definable", which
 * is exactly right, and a check that cries wolf gets switched off.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LINT = resolve(ROOT, 'scripts/lint-standards-truth.mjs');

/** Run the lint over the repository, or over a fixture tree with `--root`. */
const run = (root?: string): { status: number | null; out: string } => {
  const p = spawnSync('node', root ? [LINT, '--root', root] : [LINT], { cwd: ROOT, encoding: 'utf8' });
  return { status: p.status, out: p.stdout + p.stderr };
};

/**
 * Build a private fixture tree, run `body` against it, then delete it. Faults
 * are injected here, never into the repository, so a concurrent run or another
 * lint cannot read them and a killed run leaves nothing in the working tree.
 */
function withFixture<T>(files: Record<string, string>, body: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'olv-standards-truth-'));
  try {
    writeFileSync(join(root, 'package.json'), readFileSync(resolve(ROOT, 'package.json')));
    mkdirSync(join(root, 'docs'), { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run the lint over a fixture tree holding one probe document under docs/. */
const withLine = (line: string) =>
  withFixture({ 'docs/_standards_lint_probe.md': `# probe\n\n${line}\n` }, (root) => run(root));

describe('lint:standards-truth', () => {
  it('passes on the committed tree', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('historical release documents exempt');
  });

  it.each([
    ['PDRF 6 class 12 means Overlap.', 'extended-class-12-overlap'],
    ['Classes 19 to 22 are user-defined values.', 'named-classes-called-user-defined'],
    ['Codes 23 to 63 are user-defined.', 'reserved-range-called-user-defined'],
    ['The product meets 95% confidence accuracy.', 'bare-95-percent-accuracy'],
    ['The ISO 19115 crosswalk makes the export ISO compliant.', 'crosswalk-called-certification'],
    ['The streaming budget corresponds to LoD2.', 'citygml-lod'],
  ])('refuses %j', (line, ruleId) => {
    const r = withLine(line);
    expect(r.status).toBe(1);
    expect(r.out).toContain(ruleId);
  });

  it.each([
    'Class 12 is Overlap Points under point data record formats 0 to 5.',
    'Codes 19 to 22 are named, 23 to 63 are reserved, and only 64 and above are user definable.',
    'The crosswalk maps concepts and is not a conformance process.',
    'Only codes 64 and above are user definable.',
  ])('accepts %j', (line) => {
    expect(withLine(line).status).toBe(0);
  });

  it('writes its probe documents outside the repository', () => {
    const st = spawnSync('git', ['status', '--porcelain', '--', 'docs', 'src'], { cwd: ROOT, encoding: 'utf8' });
    expect(st.stdout).not.toContain('_standards_lint_probe');
    expect(run().status).toBe(0);
  });
});

describe('which directories the lint actually reads', () => {
  // The skip list was an unanchored alternation: `dist` matched any path
  // containing those letters, and `release$` matched `docs/release`, so two
  // documents were excluded without the output saying so. A check that stops
  // reading files reports the same clean line as one that read them all.

  it('reads a document under docs/release', () => {
    const rel = 'docs/release/_standards_lint_probe.md';
    // The first line is deliberately misspelled, so it must pass.
    expect(withFixture({ [rel]: '# probe\n\nPDFR 6 class 12 means Overlap.\n' }, run).status).toBe(0);
    const caught = withFixture({ [rel]: '# probe\n\nPDRF 6 class 12 means Overlap.\n' }, run);
    expect(caught.status).toBe(1);
    expect(caught.out).toContain(rel);
  });

  it('still skips the packaged output at the repository root', () => {
    // `release/` at the root holds build artifacts; `docs/release` does not.
    // The fixture puts a refused line in both: only the docs one is reported.
    const bad = '# probe\n\nPDRF 6 class 12 means Overlap.\n';
    const r = withFixture(
      { 'release/openlidarviewer-probe/docs/x.md': bad, 'docs/release/x.md': bad },
      run,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain('docs/release/x.md');
    expect(r.out).not.toContain('release/openlidarviewer-');
    // And the real repository, with whatever packaged output it holds, is clean.
    expect(run().status).toBe(0);
  });
});
