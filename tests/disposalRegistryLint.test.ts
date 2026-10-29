/**
 * disposalRegistryLint.test.ts — proves lint:disposal-registry reads the real
 * document and refuses a resource that names no owner.
 *
 * A registry lint that parses nothing reports the same clean line as one that
 * parses everything, so this injects each fault into a private copy of the real
 * file and requires the lint to name the resource. The real document is never
 * written, so concurrent runs cannot read or restore another run's injection.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = resolve(ROOT, 'docs/disposal-contracts.md');

const run = (doc?: string) =>
  spawnSync('node', ['scripts/lint-disposal-registry.mjs', ...(doc ? ['--doc', doc] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
  });

/** Copy the document with a row added to its first resource table, lint the copy, delete it. */
function withRow(row: string): { status: number | null; output: string } {
  const original = readFileSync(DOC, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'olv-disposal-registry-'));
  try {
    const marker = '| Resource | Owner | Lifetime | Disposal trigger |';
    const at = original.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const end = original.indexOf('\n', original.indexOf('\n', at) + 1);
    const copy = join(dir, 'disposal-contracts.md');
    writeFileSync(copy, `${original.slice(0, end)}\n${row}${original.slice(end)}`);
    const proc = run(copy);
    return { status: proc.status, output: proc.stdout + proc.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

  it('never writes the real document', () => {
    expect(readFileSync(DOC, 'utf8')).not.toContain('Orphan GPU buffer');
    expect(run().status).toBe(0);
  });
});
