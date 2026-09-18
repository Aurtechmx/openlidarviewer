/**
 * disposalRegistryLint.test.ts — proves lint:disposal-registry reads the real
 * document and refuses a resource that names no owner.
 *
 * A registry lint that parses nothing reports the same clean line as one that
 * parses everything, so this injects each fault into the real file and requires
 * the lint to name the resource, then restores it.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = resolve(ROOT, 'docs/disposal-contracts.md');

const run = () =>
  spawnSync('node', ['scripts/lint-disposal-registry.mjs'], { cwd: ROOT, encoding: 'utf8' });

/** Append a row to the first resource table, run the lint, restore the file. */
function withRow(row: string): { status: number | null; output: string } {
  const original = readFileSync(DOC, 'utf8');
  try {
    const marker = '| Resource | Owner | Lifetime | Disposal trigger |';
    const at = original.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const end = original.indexOf('\n', original.indexOf('\n', at) + 1);
    const patched = `${original.slice(0, end)}\n${row}${original.slice(end)}`;
    writeFileSync(DOC, patched);
    const proc = run();
    return { status: proc.status, output: proc.stdout + proc.stderr };
  } finally {
    writeFileSync(DOC, original);
  }
}

describe('lint:disposal-registry', () => {
  it('passes on the committed document', () => {
    const proc = run();
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('every one naming an owner');
  });

  it('refuses a resource with no owner', () => {
    const r = withRow('| Orphan GPU buffer |  | Per scan | `dispose()` |');
    expect(r.status).toBe(1);
    expect(r.output).toContain('Orphan GPU buffer');
    expect(r.output).toContain('no owner');
  });

  it('refuses a placeholder owner', () => {
    const r = withRow('| Orphan worker | TBD | Per scan | `terminate()` |');
    expect(r.status).toBe(1);
    expect(r.output).toContain('no owner');
  });

  it('refuses a resource with no disposal trigger', () => {
    const r = withRow('| Leaky interval | `someController` | Per scan |  |');
    expect(r.status).toBe(1);
    expect(r.output).toContain('no disposal trigger');
  });

  it('accepts a complete row', () => {
    const r = withRow('| Example handle | `ExampleOwner` | Per scan | `close()` |');
    expect(r.status).toBe(0);
  });

  it('restores the document after each injection', () => {
    expect(readFileSync(DOC, 'utf8')).not.toContain('Orphan GPU buffer');
    expect(run().status).toBe(0);
  });
});
