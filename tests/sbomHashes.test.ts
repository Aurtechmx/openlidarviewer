/**
 * sbomHashes.test.ts: each SBOM component's distribution SHA-512 is the
 * lockfile integrity of the tarball at that component's version.
 *
 * `gen:provenance` moves a component's version, purl and tarball URL when the
 * lockfile moves. It must move the SHA-512 too, and `lint:sbom` must reject an
 * SBOM whose digest belongs to another version of the package.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: plain .mjs script, no types
import { syncSbom, sha512HexFromIntegrity } from '../scripts/sync-provenance.mjs';
// @ts-expect-error: plain .mjs script, no types
import { collectSbomProblems } from '../scripts/lint-sbom.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

type Hash = { alg: string; content: string };
type Ref = { type: string; url: string; hashes?: Hash[] };
type Component = { name: string; group?: string; version: string; purl?: string; 'bom-ref'?: string; externalReferences?: Ref[] };
type Lock = { packages: Record<string, { version?: string; integrity?: string }> };

const pkg = JSON.parse(readText('package.json'));
const lock: Lock = JSON.parse(readText('package-lock.json'));
const sbomText = readText('sbom.json');

const lookups = {
  pkg,
  lockedVersion: (n: string) => lock.packages[`node_modules/${n}`]?.version ?? null,
  lockedSha512: (n: string) => sha512HexFromIntegrity(lock.packages[`node_modules/${n}`]?.integrity),
};

const distSha = (c: Component): string | undefined =>
  c.externalReferences?.find((r) => r.type === 'distribution')?.hashes?.find((h) => h.alg === 'SHA-512')?.content;

// The three@0.186.0 tarball digest, as the SBOM carried it before the 0.186.1 bump.
const THREE_0_186_0_SHA512 =
  '72bfdf20cd9d74c4956d856091f0f88cb26fec587ff194e3be8fbb8107925465191f1a71f450f0a0be620bb854cff2e2440f3031ba9f9dbf74c4a7e6d7f1c791';

/** The committed SBOM with three rolled back to an older version and digest. */
function staleThreeSbom(): string {
  const sbom = JSON.parse(sbomText);
  const three = (sbom.components as Component[]).find((c) => c.name === 'three')!;
  const now = three.version;
  three.version = '0.186.0';
  three.purl = three.purl!.replace(`@${now}`, '@0.186.0');
  for (const r of three.externalReferences ?? []) {
    if (r.type !== 'distribution') continue;
    r.url = r.url.replace(`-${now}.tgz`, '-0.186.0.tgz');
    for (const h of r.hashes ?? []) if (h.alg === 'SHA-512') h.content = THREE_0_186_0_SHA512;
  }
  return JSON.stringify(sbom, null, 2) + '\n';
}

describe('SBOM distribution hashes', () => {
  it('the committed SBOM carries the lockfile digest for every component', () => {
    for (const c of JSON.parse(sbomText).components as Component[]) {
      const full = c.group ? `${c.group}/${c.name}` : c.name;
      expect(distSha(c), full).toBe(lookups.lockedSha512(full));
    }
  });

  it('gen:provenance replaces the digest when it moves a component to the locked version', () => {
    const out = JSON.parse(syncSbom(staleThreeSbom(), lookups));
    const three = (out.components as Component[]).find((c) => c.name === 'three')!;
    expect(three.version).toBe(lookups.lockedVersion('three'));
    expect(distSha(three)).toBe(lookups.lockedSha512('three'));
    expect(distSha(three)).not.toBe(THREE_0_186_0_SHA512);
  });

  it('gen:provenance is a byte-identical no-op on the committed SBOM, run twice', () => {
    const once = syncSbom(sbomText, lookups);
    expect(once).toBe(sbomText);
    expect(syncSbom(once, lookups)).toBe(once);
  });

  it('lint:sbom rejects a digest that belongs to another version of the package', () => {
    const sbom = JSON.parse(sbomText);
    const three = (sbom.components as Component[]).find((c) => c.name === 'three')!;
    for (const r of three.externalReferences ?? []) {
      for (const h of r.hashes ?? []) if (h.alg === 'SHA-512') h.content = THREE_0_186_0_SHA512;
    }
    const read = (p: string): string | null => (p === 'sbom.json' ? JSON.stringify(sbom) : readText(p));
    const problems = collectSbomProblems(read).problems as string[];
    expect(problems.some((p) => /SHA-512 for "three@/.test(p))).toBe(true);
  });

  it('lint:sbom rejects a component with no distribution digest', () => {
    const sbom = JSON.parse(sbomText);
    const three = (sbom.components as Component[]).find((c) => c.name === 'three')!;
    for (const r of three.externalReferences ?? []) if (r.type === 'distribution') delete r.hashes;
    const read = (p: string): string | null => (p === 'sbom.json' ? JSON.stringify(sbom) : readText(p));
    const problems = collectSbomProblems(read).problems as string[];
    expect(problems.some((p) => /"three@.*no SHA-512/.test(p))).toBe(true);
  });
});
