/**
 * sbomLint.test.ts — the SBOM describes THIS release's lockfile.
 *
 * `lint:release-sync` already checks the SBOM's root identity, which caught an
 * archive shipping an alpha.2 root. It does not check the component SET, and an
 * SBOM can carry a correct version header while listing dependencies from an
 * older release. These tests cover that gap, and pin the scoped-package case
 * that made the first version of this lint report every `@scope/pkg` as missing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs script, no types
import { collectSbomProblems } from '../scripts/lint-sbom.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realRead = (p: string): string | null =>
  existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null;

const problemsFor = (read: (p: string) => string | null): string[] =>
  collectSbomProblems(read).problems as string[];

/** The real tree with sbom.json swapped for a mutated copy. */
function withSbom(mutate: (sbom: Record<string, unknown>) => void) {
  const sbom = JSON.parse(realRead('sbom.json')!);
  mutate(sbom);
  return (p: string): string | null => (p === 'sbom.json' ? JSON.stringify(sbom) : realRead(p));
}

describe('lint:sbom', () => {
  it('passes on the committed SBOM', () => {
    expect(problemsFor(realRead)).toEqual([]);
  });

  it('accepts scoped packages stored as group + name', () => {
    // Regression: CycloneDX writes "@loaders.gl/core" as group "@loaders.gl",
    // name "core". Keying on `name` alone failed every scoped dependency.
    const sbom = JSON.parse(realRead('sbom.json')!);
    const scoped = sbom.components.filter((c: { group?: string }) => c.group);
    expect(scoped.length).toBeGreaterThan(0);
    expect(problemsFor(realRead)).toEqual([]);
  });

  it('fails when a direct production dependency is absent', () => {
    const problems = problemsFor(
      withSbom((s) => {
        const c = s.components as Array<{ name: string }>;
        s.components = c.filter((x) => x.name !== 'three');
      }),
    );
    expect(problems.some((p) => p.includes('three'))).toBe(true);
  });

  it('fails when a component version disagrees with the lockfile', () => {
    const problems = problemsFor(
      withSbom((s) => {
        const c = (s.components as Array<{ name: string; version: string }>).find(
          (x) => x.name === 'three',
        )!;
        c.version = '0.999.0';
      }),
    );
    expect(problems.some((p) => p.includes('three') && p.includes('0.999.0'))).toBe(true);
  });

  it('fails on a superseded root version', () => {
    const problems = problemsFor(
      withSbom((s) => {
        (s.metadata as { component: { version: string } }).component.version = '0.6.0-alpha.2';
      }),
    );
    expect(problems.some((p) => p.includes('root version'))).toBe(true);
  });

  it('fails on a wrong root name', () => {
    const problems = problemsFor(
      withSbom((s) => {
        (s.metadata as { component: { name: string } }).component.name = 'not-openlidarviewer';
      }),
    );
    expect(problems.some((p) => p.includes('root component name'))).toBe(true);
  });

  it('fails when bom-ref or purl does not identify this version', () => {
    const problems = problemsFor(
      withSbom((s) => {
        (s.metadata as { component: Record<string, string> }).component['bom-ref'] =
          'openlidarviewer@0.0.1';
      }),
    );
    expect(problems.some((p) => p.includes('bom-ref'))).toBe(true);
  });

  it('fails on a non-CycloneDX document', () => {
    const problems = problemsFor(
      withSbom((s) => {
        s.bomFormat = 'SPDX';
      }),
    );
    expect(problems.some((p) => p.includes('bomFormat'))).toBe(true);
  });

  it('fails on an empty component set', () => {
    const problems = problemsFor(
      withSbom((s) => {
        s.components = [];
      }),
    );
    expect(problems.some((p) => p.includes('zero components'))).toBe(true);
  });

  it('fails on unparseable JSON rather than throwing', () => {
    const read = (p: string): string | null => (p === 'sbom.json' ? '{ not json' : realRead(p));
    expect(problemsFor(read).some((p) => p.includes('not valid JSON'))).toBe(true);
  });

  it('reports a missing SBOM', () => {
    const read = (p: string): string | null => (p === 'sbom.json' ? null : realRead(p));
    expect(problemsFor(read).some((p) => p.includes('missing'))).toBe(true);
  });
});
