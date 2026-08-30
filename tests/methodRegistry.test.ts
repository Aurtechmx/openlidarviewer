/**
 * methodRegistry.test.ts — invariants of the scientific method catalogue.
 *
 * Guards the properties provenance relies on: ids are well-formed and match
 * their keys, versions are positive integers, every entry carries a citation,
 * and the lookup / tag helpers behave (including refusing an unknown id, so a
 * record can never reference a method the registry does not define).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  METHOD_REGISTRY,
  method,
  isMethodId,
  methodRef,
  methodTag,
} from '../src/science/methodRegistry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('METHOD_REGISTRY invariants', () => {
  it('every key equals its entry id and is namespaced olv.<area>.<method>[.<variant>]', () => {
    for (const [key, entry] of Object.entries(METHOD_REGISTRY)) {
      expect(entry.id).toBe(key);
      // area.method, plus optional dotted variant segments (e.g.
      // olv.contour.generalize.terrain-adaptive names a variant of a method).
      expect(key).toMatch(/^olv\.[a-z]+\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/);
    }
  });

  it('docs/science/METHOD_REGISTRY.md lists every registered method (doc↔registry parity)', () => {
    const doc = readFileSync(resolve(ROOT, 'docs/science/METHOD_REGISTRY.md'), 'utf8');
    const documented = new Set(
      [...doc.matchAll(/`(olv\.[a-z0-9.-]+)`/g)].map((m) => m[1]),
    );
    const missing = Object.keys(METHOD_REGISTRY).filter((id) => !documented.has(id));
    expect(missing, `METHOD_REGISTRY.md omits: ${missing.join(', ')}`).toEqual([]);
  });

  it('docs/science/METHOD_REGISTRY.md names no method the registry does not define', () => {
    const doc = readFileSync(resolve(ROOT, 'docs/science/METHOD_REGISTRY.md'), 'utf8');
    // Only the table rows name real ids; a prose example id would be a false
    // positive, so restrict to backticked ids on table rows (lines starting "|").
    const rowIds = doc
      .split('\n')
      .filter((l) => l.startsWith('| `olv.'))
      .flatMap((l) => [...l.matchAll(/`(olv\.[a-z0-9.-]+)`/g)].map((m) => m[1]));
    const unknown = rowIds.filter((id) => !isMethodId(id));
    expect(unknown, `METHOD_REGISTRY.md rows name unregistered ids: ${unknown.join(', ')}`).toEqual([]);
  });

  it('every version is a positive integer', () => {
    for (const entry of Object.values(METHOD_REGISTRY)) {
      expect(Number.isInteger(entry.version)).toBe(true);
      expect(entry.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('every entry carries a non-empty name, summary and citation', () => {
    for (const entry of Object.values(METHOD_REGISTRY)) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.citation.length).toBeGreaterThan(0);
    }
  });

  it('every entry names at least one implementation source path', () => {
    for (const entry of Object.values(METHOD_REGISTRY)) {
      expect(entry.implementation.length, `${entry.id} has no implementation`).toBeGreaterThan(0);
      for (const p of entry.implementation) {
        expect(p, `${entry.id} implementation path`).toMatch(/^src\/.+\.ts$/);
      }
    }
  });

  it('every declared implementation path exists in the tree', () => {
    const missing: string[] = [];
    for (const entry of Object.values(METHOD_REGISTRY)) {
      for (const p of entry.implementation) {
        if (!existsSync(resolve(ROOT, p))) missing.push(`${entry.id} → ${p}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('lookup + tag helpers', () => {
  it('method() returns the entry or null', () => {
    expect(method('olv.terrain.vrm')?.name).toMatch(/Ruggedness/);
    expect(method('olv.does.not-exist')).toBeNull();
  });

  it('isMethodId reflects membership', () => {
    expect(isMethodId('olv.validation.spatial-block')).toBe(true);
    expect(isMethodId('nope')).toBe(false);
  });

  it('methodRef returns id+version and refuses an unknown id', () => {
    expect(methodRef('olv.validation.spatial-block')).toEqual({
      id: 'olv.validation.spatial-block',
      version: 2,
    });
    expect(() => methodRef('olv.ghost')).toThrow(/Unknown method id/);
  });

  it('methodTag renders the stable id@version form', () => {
    expect(methodTag(methodRef('olv.validation.spatial-block'))).toBe(
      'olv.validation.spatial-block@2',
    );
  });
});
