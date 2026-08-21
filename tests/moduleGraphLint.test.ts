/**
 * moduleGraphLint.test.ts: proves scripts/lint-module-graph.mjs is green on the
 * committed tree, and that its ratchet points the way it claims to.
 *
 * The three cases are the three states a shrink-only guard can be in. Green on
 * the tree as it stands is the one the baseline was generated for. Below the
 * baseline passes, because coupling falling is the outcome the guard exists to
 * protect. Above the baseline fails, and the message has to name the category
 * and the specific edge, since a bare count tells a reader nothing about what
 * to undo.
 *
 * The growth case is driven by editing the BASELINE, not src/: lowering a
 * recorded number is the same comparison as adding an import, and it keeps the
 * test free of a fixture module that would then have to be excluded from every
 * other scan in the repo.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/module-graph-baseline.json');

const runLint = () =>
  spawnSync('node', ['scripts/lint-module-graph.mjs'], { cwd: ROOT, encoding: 'utf8' });

/** Run `edit` against a copy of the baseline, then put the real one back. */
function withBaseline(edit: (doc: any) => void, body: (r: ReturnType<typeof runLint>) => void) {
  const original = readFileSync(BASELINE, 'utf8');
  try {
    const doc = JSON.parse(original);
    edit(doc);
    writeFileSync(BASELINE, `${JSON.stringify(doc, null, 2)}\n`);
    body(runLint());
  } finally {
    writeFileSync(BASELINE, original);
  }
}

describe('lint:module-graph', () => {
  it('passes on the committed tree', () => {
    const r = runLint();
    expect(r.stderr + r.stdout).toContain('lint:module-graph OK');
    expect(r.status).toBe(0);
  });

  it('passes when a measured number is BELOW its baseline', () => {
    withBaseline(
      (doc) => {
        doc.edges['render->ui'].runtime += 5;
      },
      (r) => {
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('fewer than baseline');
      },
    );
  });

  it('fails when a measured number EXCEEDS its baseline, naming the new edge', () => {
    const recorded = JSON.parse(readFileSync(BASELINE, 'utf8')).edges['render->ui'].edges as string[];
    const dropped = recorded[0];
    withBaseline(
      (doc) => {
        doc.edges['render->ui'].runtime -= 1;
        doc.edges['render->ui'].edges = recorded.slice(1);
      },
      (r) => {
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('lint:module-graph FAILED');
        expect(r.stderr).toContain('render->ui');
        expect(r.stderr).toContain(`new: ${dropped}`);
      },
    );
    // The baseline is restored, so a follow-up run is green again.
    expect(runLint().status).toBe(0);
  });
});
