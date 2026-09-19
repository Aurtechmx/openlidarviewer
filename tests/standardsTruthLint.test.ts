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
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = 'docs/_standards_lint_probe.md';

const run = (): { status: number | null; out: string } => {
  const p = spawnSync('node', ['scripts/lint-standards-truth.mjs'], { cwd: ROOT, encoding: 'utf8' });
  return { status: p.status, out: p.stdout + p.stderr };
};

/** Run the lint with one line written into a scratch document under docs/. */
function withLine(line: string): { status: number | null; out: string } {
  const abs = resolve(ROOT, SCRATCH);
  mkdirSync(dirname(abs), { recursive: true });
  try {
    writeFileSync(abs, `# probe\n\n${line}\n`);
    return run();
  } finally {
    rmSync(abs, { force: true });
  }
}

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

  it('leaves no probe document behind', () => {
    expect(run().status).toBe(0);
  });
});
