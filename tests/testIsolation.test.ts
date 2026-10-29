/**
 * testIsolation.test.ts — why fault-injection tests use private fixture trees,
 * and proof that the tree check catches a run that leaves the repository changed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotTree, describeTreeChange } from './support/treeSnapshot';

const dirs: string[] = [];
const tmp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `olv-isolation-${tag}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('restore-in-place fault injection', () => {
  it('leaves an injected row behind when two runs interleave', () => {
    // The old pattern: read the document, write a patched copy over it, run the
    // lint, write the read text back. Two runs of it, interleaved.
    const doc = join(tmp('race'), 'registry.md');
    writeFileSync(doc, '| Resource | Owner |\n|---|---|\n');
    const originalA = readFileSync(doc, 'utf8');
    writeFileSync(doc, `${originalA}| Orphan GPU buffer |  |\n`);
    const originalB = readFileSync(doc, 'utf8'); // B reads A's injection as the original
    writeFileSync(doc, `${originalB}| Orphan worker | TBD |\n`);
    writeFileSync(doc, originalA); // A restores
    writeFileSync(doc, originalB); // B "restores" A's injection
    expect(readFileSync(doc, 'utf8')).toContain('Orphan GPU buffer');
  });

  it('cannot leave anything behind when each run patches its own copy', () => {
    const doc = join(tmp('copy'), 'registry.md');
    const committed = '| Resource | Owner |\n|---|---|\n';
    writeFileSync(doc, committed);
    const copyA = join(tmp('a'), 'registry.md');
    const copyB = join(tmp('b'), 'registry.md');
    writeFileSync(copyA, `${readFileSync(doc, 'utf8')}| Orphan GPU buffer |  |\n`);
    writeFileSync(copyB, `${readFileSync(doc, 'utf8')}| Orphan worker | TBD |\n`);
    expect(readFileSync(copyB, 'utf8')).not.toContain('Orphan GPU buffer');
    expect(readFileSync(doc, 'utf8')).toBe(committed);
  });
});

describe('working-tree check', () => {
  function repo(): string {
    const d = tmp('repo');
    const git = (...a: string[]) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(d, 'doc.md'), 'committed\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    return d;
  }

  it('passes when nothing changed', () => {
    const d = repo();
    const before = snapshotTree(d)!;
    expect(describeTreeChange(before, snapshotTree(d)!)).toBeNull();
  });

  it('fails on an untracked probe document', () => {
    const d = repo();
    const before = snapshotTree(d)!;
    writeFileSync(join(d, '_probe.md'), 'x\n');
    expect(describeTreeChange(before, snapshotTree(d)!)).toContain('_probe.md');
  });

  it('fails on an edit to a tracked document', () => {
    const d = repo();
    const before = snapshotTree(d)!;
    writeFileSync(join(d, 'doc.md'), 'committed\n| injected row |\n');
    expect(describeTreeChange(before, snapshotTree(d)!)).toContain('doc.md');
  });

  it('fails on a further edit to a file that was already modified', () => {
    const d = repo();
    writeFileSync(join(d, 'doc.md'), 'local edit\n');
    const before = snapshotTree(d)!;
    writeFileSync(join(d, 'doc.md'), 'local edit\n| injected row |\n');
    expect(describeTreeChange(before, snapshotTree(d)!)).toContain('edited again');
  });

  it('is skipped outside a git checkout', () => {
    expect(snapshotTree(tmp('nogit'))).toBeNull();
  });
});
