/**
 * unreachableModulesLint.test.ts — proves scripts/lint-unreachable-modules.mjs
 * is green on the committed tree, and that it rejects for the stated reason.
 *
 * A completeness gate that cannot fire looks exactly like one that works, so
 * each rule gets input it must reject and the assertion names the rule id:
 *
 *   U1  an unreachable module absent from the register  (the whole point)
 *   U2  a registered module production now reaches      (it graduated)
 *   U3  a register entry naming no file
 *   U5  a register entry missing the fields that classify it
 *
 * Every case is driven by editing a COPY of the REGISTER, not by adding a
 * module to src/. Deleting an entry is the same comparison as adding an
 * unreferenced file, and it keeps the suite from leaving a fixture module in
 * the tree that every other scan in the repository would then have to exclude.
 * The one case that cannot be reached that way — a brand new file nobody
 * imports — is what the CLI proof in the pull request covers.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER = resolve(ROOT, 'docs/validation/unreachable-modules.json');

const runLint = (...args: string[]) =>
  spawnSync('node', ['scripts/lint-unreachable-modules.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });

/** Run `edit` against a copy of the register, then put the real one back. */
function withRegister(
  edit: (doc: any) => void,
  body: (r: ReturnType<typeof runLint>) => void,
): void {
  const original = readFileSync(REGISTER, 'utf8');
  try {
    const doc = JSON.parse(original);
    edit(doc);
    writeFileSync(REGISTER, `${JSON.stringify(doc, null, 2)}\n`);
    body(runLint());
  } finally {
    writeFileSync(REGISTER, original);
  }
}

describe('lint:unreachable-modules', () => {
  it('passes on the committed tree', () => {
    const r = runLint();
    expect(r.stderr + r.stdout).toContain('lint:unreachable-modules OK');
    expect(r.status).toBe(0);
  });

  it('measures the same set the register describes', () => {
    const r = runLint('--list');
    expect(r.status).toBe(0);
    const listed = r.stdout
      .split('\n')
      .filter((l) => l.startsWith('  src/'))
      .map((l) => l.trim());
    const registered = (JSON.parse(readFileSync(REGISTER, 'utf8')).modules as { path: string }[])
      .map((m) => m.path);
    expect([...listed].sort()).toEqual([...registered].sort());
  });

  it('counts src/lazyChunks.ts, so a lazily-reached module is reachable', () => {
    // openTilesetLayer.ts is reached ONLY through the dynamic import() literals
    // in src/lazyChunks.ts. A walk that stopped at the lazy boundary would
    // report it, and most of the application behind it, as unreachable.
    const listed = runLint('--list').stdout;
    expect(listed).not.toContain('src/app/openTilesetLayer.ts');
    expect(listed).not.toContain('src/lazyChunks.ts');
  });

  it('[U1] fails when an unreachable module is absent from the register', () => {
    const dropped = (JSON.parse(readFileSync(REGISTER, 'utf8')).modules as { path: string }[])[0].path;
    withRegister(
      (doc) => {
        doc.modules = doc.modules.filter((m: { path: string }) => m.path !== dropped);
      },
      (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('lint:unreachable-modules FAILED');
        expect(r.stderr).toContain('[U1 unregistered]');
        expect(r.stderr).toContain(dropped);
      },
    );
  });

  it('[U2] fails when a registered module is one production reaches', () => {
    withRegister(
      (doc) => {
        doc.modules.push({
          path: 'src/main.ts',
          status: 'staged',
          why: 'the entry point, which production plainly reaches',
          graduation: 'none',
          review: '2027-01-01',
        });
      },
      (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('[U2 graduated]');
        expect(r.stderr).toContain('src/main.ts');
      },
    );
  });

  it('[U3] fails when an entry names no file under src/', () => {
    withRegister(
      (doc) => {
        doc.modules.push({
          path: 'src/nowhere/gone.ts',
          status: 'orphan',
          why: 'deleted in an earlier release',
          graduation: 'none',
          review: '2027-01-01',
        });
      },
      (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('[U3 absent]');
        expect(r.stderr).toContain('src/nowhere/gone.ts');
      },
    );
  });

  it('[U5] fails on an unknown status, a missing reason and a malformed date', () => {
    withRegister(
      (doc) => {
        const entry = doc.modules[0];
        entry.status = 'someday';
        entry.why = '';
        entry.review = 'soon';
      },
      (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('[U5 schema]');
        expect(r.stderr).toContain('"someday"');
        expect(r.stderr).toContain('`why` is missing');
        expect(r.stderr).toContain('ISO date');
      },
    );
  });

  it('[U4] fails when one module is registered twice', () => {
    withRegister(
      (doc) => {
        doc.modules.push({ ...doc.modules[0] });
      },
      (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('[U4 duplicate]');
      },
    );
  });

  it('names every registered module with a status, a reason, a gate and a date', () => {
    const doc = JSON.parse(readFileSync(REGISTER, 'utf8'));
    const allowed = new Set(Object.keys(doc.statuses));
    for (const m of doc.modules as Record<string, string>[]) {
      expect(allowed.has(m.status), `${m.path} status`).toBe(true);
      expect(m.why.length, `${m.path} why`).toBeGreaterThan(30);
      expect(m.graduation.length, `${m.path} graduation`).toBeGreaterThan(10);
      expect(m.review).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
