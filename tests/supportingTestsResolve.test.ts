/**
 * supportingTestsResolve.test.ts — every claim's supportingTests must name real
 * tests.
 *
 * docs/validation/claim-register.yaml binds each scientific claim to the tests
 * that stand behind it, as globs (`tests/measure*.test.ts`) or exact paths.
 * Nothing checked that those globs still match a file, so a renamed or deleted
 * test silently orphaned a claim's evidence — the register kept pointing at a
 * test that no longer exists. This resolves every entry against the real test
 * tree and fails on any that matches nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file under tests/, as repo-relative POSIX paths. */
function testFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(resolve(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk('tests');
  return out;
}

/** A `tests/…*.test.ts`-style glob (only `*`, no `**`) as an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metachars (not `*`)
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${body}$`);
}

/** Every distinct supportingTests entry in the register. */
function supportingTestEntries(): string[] {
  const yaml = readFileSync(resolve(ROOT, 'docs/validation/claim-register.yaml'), 'utf8');
  const entries = new Set<string>();
  for (const m of yaml.matchAll(/supportingTests:\s*\[([^\]]*)\]/g)) {
    for (const raw of m[1].split(',')) {
      const t = raw.trim();
      if (t) entries.add(t);
    }
  }
  return [...entries];
}

describe('claim-register supportingTests', () => {
  const files = testFiles();
  const entries = supportingTestEntries();

  it('has supportingTests entries to check', () => {
    expect(entries.length).toBeGreaterThan(10);
  });

  it('every supportingTests entry resolves to at least one real test file', () => {
    const orphaned = entries.filter((e) => {
      const re = globToRegExp(e);
      return !files.some((f) => re.test(f));
    });
    expect(orphaned, `supportingTests naming no real test: ${orphaned.join(', ')}`).toEqual([]);
  });
});
