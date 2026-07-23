/**
 * validateReleaseRef.test.ts — a release run refuses an unpublishable ref
 * before it spends an hour proving nothing.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no types
import { validateReleaseRef } from '../scripts/validate-release-ref.mjs';

const VERSION = '0.6.0-alpha.3';
const TAG = `v${VERSION}`;
const HEAD = 'a'.repeat(40);

/** A tree where every document agrees; individual cases spoil one thing. */
function files(over: Record<string, string | null> = {}) {
  const base: Record<string, string | null> = {
    'package.json': JSON.stringify({ version: VERSION }),
    'package-lock.json': JSON.stringify({ version: VERSION, packages: { '': { version: VERSION } } }),
    'CITATION.cff': `version: ${VERSION}\n`,
    'sbom.json': JSON.stringify({ metadata: { component: { version: VERSION } } }),
    [`RELEASE_NOTES_v${VERSION}.md`]: 'notes',
    [`KNOWN_LIMITATIONS_v${VERSION}.md`]: 'limits',
    [`VALIDATION_REPORT_v${VERSION}.md`]: 'validation',
    [`REPRODUCIBILITY_v${VERSION}.md`]: 'repro',
    ...over,
  };
  return { read: (p: string) => (p in base ? base[p] : null) };
}

const run = (o: Record<string, unknown> = {}) =>
  validateReleaseRef({
    env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: TAG },
    git: { head: HEAD, tagTarget: HEAD, dirty: false },
    files: files(),
    requireTag: true,
    ...o,
  }) as { ok: boolean; problems: string[] };

describe('validateReleaseRef', () => {
  it('accepts a clean, tagged, self-consistent ref', () => {
    const r = run();
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('refuses a non-tag ref for publication', () => {
    const r = run({ env: { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' } });
    expect(r.problems.some((p) => p.includes('requires a tag ref'))).toBe(true);
  });

  it('refuses a tag that does not match package.json', () => {
    const r = run({ env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.5.9' } });
    expect(r.problems.some((p) => p.includes('is not v0.6.0-alpha.3'))).toBe(true);
  });

  it('refuses when the tag does not point at HEAD', () => {
    // The defect this whole pass exists to remove: a tag on a commit that is
    // not the one being built.
    const r = run({ git: { head: HEAD, tagTarget: 'b'.repeat(40), dirty: false } });
    expect(r.problems.some((p) => p.includes('is not the v0.6.0-alpha.3 target'))).toBe(true);
  });

  it('refuses a dirty working tree', () => {
    const r = run({ git: { head: HEAD, tagTarget: HEAD, dirty: true } });
    expect(r.problems.some((p) => p.includes('not clean'))).toBe(true);
  });

  it('refuses lockfile, citation or SBOM version drift', () => {
    expect(
      run({ files: files({ 'package-lock.json': JSON.stringify({ version: '0.5.9', packages: { '': { version: '0.5.9' } } }) }) })
        .problems.some((p) => p.includes('package-lock')),
    ).toBe(true);
    expect(
      run({ files: files({ 'CITATION.cff': 'version: 0.5.9\n' }) })
        .problems.some((p) => p.includes('CITATION.cff')),
    ).toBe(true);
    expect(
      run({ files: files({ 'sbom.json': JSON.stringify({ metadata: { component: { version: '0.6.0-alpha.2' } } }) }) })
        .problems.some((p) => p.includes('SBOM root version')),
    ).toBe(true);
  });

  it('refuses when a promised evidence document is missing', () => {
    for (const doc of [
      `RELEASE_NOTES_v${VERSION}.md`,
      `KNOWN_LIMITATIONS_v${VERSION}.md`,
      `VALIDATION_REPORT_v${VERSION}.md`,
      `REPRODUCIBILITY_v${VERSION}.md`,
    ]) {
      const r = run({ files: files({ [doc]: null }) });
      expect(r.problems.some((p) => p.includes(doc))).toBe(true);
    }
  });

  it('skips the tag rules for a non-publication run', () => {
    // A branch push should still check version agreement, without demanding a tag.
    const r = run({
      requireTag: false,
      env: { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' },
      git: { head: HEAD, tagTarget: null, dirty: false },
    });
    expect(r.ok).toBe(true);
  });
});
