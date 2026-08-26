/**
 * digestManifestLint.test.ts — the rules in scripts/lint-digest-manifests.mjs.
 *
 * Two manifests under validation/terrain-field/ were read by nothing: a digest
 * could be replaced with zeros and validation:field:verify, test:terrain and
 * verify:archive-gate all stayed green. The cases below drive the rule logic
 * through seeded accessors, so they describe the rules rather than whatever the
 * repository holds today. One case runs the real tree.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - plain .mjs script, no types
import { collectDigestProblems, parseManifest, isManifestName } from '../scripts/lint-digest-manifests.mjs';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** Seed a single manifest with a digest table for the files it names. */
function seed(manifest: string, text: string, digests: Record<string, string | null>) {
  return {
    listFiles: (root: string) => (manifest.startsWith(root) ? [manifest] : []),
    readText: (p: string) => (p === manifest ? text : null),
    digestOf: (p: string) => digests[p] ?? null,
  };
}
const problemsOf = (a: Parameters<typeof collectDigestProblems>[0]) =>
  collectDigestProblems(a).problems as string[];

describe('manifest names', () => {
  it('recognises the three spellings the tree uses', () => {
    expect(isManifestName('SHA256SUMS')).toBe(true);
    expect(isManifestName('SHA256SUMS.txt')).toBe(true);
    expect(isManifestName('pdal-SHA256SUMS')).toBe(true);
    expect(isManifestName('README.md')).toBe(false);
  });
});

describe('parsing', () => {
  it('reads a digest and its path, with or without the binary star', () => {
    const { entries, malformed } = parseManifest(`${A}  one.bin\n${B} *two.bin\n`);
    expect(malformed).toEqual([]);
    expect(entries).toEqual([
      { sha256: A, path: 'one.bin' },
      { sha256: B, path: 'two.bin' },
    ]);
  });

  it('reports a line that is not a digest and a path', () => {
    expect(parseManifest(`${A}  one.bin\nnot a digest line\n`).malformed).toEqual([2]);
  });
});

describe('rules', () => {
  it('passes when every present file matches', () => {
    const p = problemsOf(
      seed('validation/x/SHA256SUMS', `${A}  one.bin\n`, { 'validation/x/one.bin': A }),
    );
    expect(p).toEqual([]);
  });

  it('fails on the zeroed digest that no other gate saw', () => {
    const zero = '0'.repeat(64);
    const p = problemsOf(
      seed('validation/terrain-field/SHA256SUMS', `${zero}  crops/c.f32\n`, {
        'validation/terrain-field/crops/c.f32': A,
      }),
    );
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('crops/c.f32');
    expect(p[0]).toContain('was not repinned');
  });

  it('counts an absent file instead of failing, for regenerated outputs', () => {
    const p = problemsOf(
      seed('validation/cross-implementation/pdal-SHA256SUMS', `${A}  out.tif\n`, {}),
    );
    expect(p).toEqual([]);
  });

  it('still checks the present entries of a partly regenerated manifest', () => {
    const p = problemsOf(
      seed('validation/x/SHA256SUMS', `${A}  gone.tif\n${A}  here.tif\n`, {
        'validation/x/here.tif': B,
      }),
    );
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('here.tif');
  });

  it('refuses a manifest that lists nothing', () => {
    const p = problemsOf(seed('validation/x/SHA256SUMS', '\n\n', {}));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('lists nothing');
  });

  it('reports a malformed line', () => {
    const p = problemsOf(seed('validation/x/SHA256SUMS', 'garbage\n', {}));
    expect(p.some((s) => s.includes('is not a "<sha256>  <path>" line'))).toBe(true);
  });
});

describe('wiring', () => {
  it('the release chain runs it', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['lint:digest-manifests']).toBe('node scripts/lint-digest-manifests.mjs');
    expect(
      pkg.scripts['test:release:execute'].indexOf('npm run lint:digest-manifests'),
      'a lint outside the release chain guards nothing at release time',
    ).toBeGreaterThan(-1);
  });
});
