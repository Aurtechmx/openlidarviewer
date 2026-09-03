/**
 * releaseTruthLint.test.ts — proves scripts/lint-release-truth.mjs fails on each
 * known stale-truth phrase, and passes on the real tree.
 *
 * The lint's rule logic is a pure function of a `read(path)` accessor, so each
 * case seeds a reader with the REAL current files and overrides exactly one to
 * reintroduce a defect. A rule that stopped firing would let the corresponding
 * drift ship again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs script, no types
import { collectReleaseTruthProblems } from '../scripts/lint-release-truth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realRead = (p: string): string | null =>
  existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null;

const VERSION = JSON.parse(realRead('package.json')!).version as string;
const KNOWN = `docs/releases/KNOWN_LIMITATIONS_v${VERSION}.md`;
const VALREPORT = `docs/releases/VALIDATION_REPORT_v${VERSION}.md`;
const CLAIMS = 'docs/validation/claim-register.yaml';
const DEPS = 'docs/project/DEPENDENCIES.md';
const NOTICES = 'docs/project/THIRD_PARTY_NOTICES.md';
const RELEASE_ASSETS = 'docs/release/RELEASE_ASSETS.md';
const RELEASE_NOTES = `docs/releases/RELEASE_NOTES_v${VERSION}.md`;
const DOCS_SITE = `docs-site/releases/v${VERSION}.md`;

/** A reader over the real tree with a single-file override. */
function withOverride(path: string, text: string) {
  return (p: string): string | null => (p === path ? text : realRead(p));
}
const problemsFor = (read: (p: string) => string | null) =>
  collectReleaseTruthProblems(read).problems as string[];

describe('lint:release-truth', () => {
  it('passes on the real current tree', () => {
    expect(problemsFor(realRead)).toEqual([]);
  });

  it('fails on a stale monolith line count', () => {
    const doc = realRead(KNOWN)! + '\n\n`src/main.ts` is 7,635 lines.\n';
    const problems = problemsFor(withOverride(KNOWN, doc));
    expect(problems.some((p) => p.includes('7,635'))).toBe(true);
  });

  it('fails on a present-tense prerelease "DISABLED in <pre>" claim', () => {
    // Rule 2 flags a present-tense claim tied to a prerelease identifier, at
    // stable versions too. Inject one; the surrounding subject is irrelevant.
    const doc = realRead(KNOWN)! + '\n\nThe monolith split was DISABLED in alpha.2.\n';
    const problems = problemsFor(withOverride(KNOWN, doc));
    expect(problems.some((p) => p.includes('DISABLED in alpha.2'))).toBe(true);
  });

  it('fails on "every reference slot is pending" while a slot is supplied', () => {
    const doc = realRead(CLAIMS)! + '\n# Every reference slot is pending.\n';
    const problems = problemsFor(withOverride(CLAIMS, doc));
    expect(problems.some((p) => /reference slot/i.test(p))).toBe(true);
  });

  it('fails on a "nothing is E4" test title while a claim is E4', () => {
    const doc = realRead('tests/evidenceRegistry.test.ts')! + '\n// nothing is E4 yet\n';
    const problems = problemsFor(withOverride('tests/evidenceRegistry.test.ts', doc));
    expect(problems.some((p) => /nothing/i.test(p) && /E4/.test(p))).toBe(true);
  });

  it('fails on "promotes no grade" while the validation report promoted claims this cycle', () => {
    // Rule 3b: the exact v0.6.7 contradiction — REPRODUCIBILITY said "promotes
    // no grade" while the validation report promoted five claims to E4.
    //
    // The contradiction is BUILT here rather than borrowed from the current
    // release. This test used to rely on the real validation report describing
    // a promotion, so it went quiet the moment a cycle promoted nothing, which
    // is exactly what v0.6.8 does. A rule that only fires on some releases must
    // still be tested on all of them.
    const REPRO = `docs/releases/REPRODUCIBILITY_v${VERSION}.md`;
    const promoted = `${realRead(VALREPORT)!}\n\nSLOPE-RASTER reaches E4 this cycle.\n`;
    const doc = (realRead(REPRO) ?? '# repro\n') + '\n\nv' + VERSION + ' promotes no grade.\n';
    const problems = problemsFor((q) =>
      q === REPRO ? doc : q === VALREPORT ? promoted : realRead(q),
    );
    expect(problems.some((p) => /no grade/i.test(p) && /contradict|promoted/i.test(p))).toBe(true);
  });

  it('fails on a stale dependency-audit version heading', () => {
    const doc = realRead(DEPS)!.replace(
      `# Dependency audit (v${VERSION})`,
      '# Dependency audit (v0.5.9)',
    );
    const problems = problemsFor(withOverride(DEPS, doc));
    expect(problems.some((p) => p.includes('stale audit'))).toBe(true);
  });

  it('fails on a direct-dependency version drift in the third-party notices', () => {
    const doc = realRead(NOTICES)!.replace('@types/proj4 | ^2.19.0', '@types/proj4 | ^2.5.6');
    const problems = problemsFor(withOverride(NOTICES, doc));
    expect(problems.some((p) => p.includes('@types/proj4'))).toBe(true);
  });

  it('fails when the validation report claims terrain evidence is inherited unchanged', () => {
    const doc =
      realRead(VALREPORT)! +
      '\n\nThe terrain and contour correctness claims are **inherited unchanged** from v0.5.9.\n';
    const problems = problemsFor(withOverride(VALREPORT, doc));
    expect(problems.some((p) => p.includes('inherited unchanged'))).toBe(true);
  });

  it('fails when the dependency audit drops the canonical toolchain', () => {
    // The heading check caught a doc titled for the wrong release; this one
    // catches a doc titled correctly while recording a stale runtime.
    // Mutate the CANONICAL version read from the pin, not a literal: this test
    // hardcoded 22.17.1 and stopped exercising the check when .nvmrc moved on,
    // because the replace no longer touched the canonical row.
    const canonical = realRead('.nvmrc')!.trim();
    const doc = realRead(DEPS)!.split(canonical).join('26.0.0');
    const problems = problemsFor(withOverride(DEPS, doc));
    expect(problems.some((p) => p.includes('canonical Node'))).toBe(true);
  });

  it('fails when the shipped asset index drops a required asset', () => {
    const doc = realRead(RELEASE_ASSETS)!.replace(/sbom\.json/gi, 'REMOVED');
    const problems = problemsFor(withOverride(RELEASE_ASSETS, doc));
    expect(problems.some((p) => p.includes('sbom.json'))).toBe(true);
  });

  const SERVICE = 'src/app/LayerService.ts';

  it('fails when a truth doc says mounting is disabled while the flag is ON', () => {
    // The real docs and flag both state mounting is enabled; make one truth doc
    // contradict the shipped flag with a disabled claim.
    const doc = realRead(KNOWN)! + '\n\nMulti-layer mounting is disabled in this build.\n';
    const problems = problemsFor(withOverride(KNOWN, doc));
    expect(problems.some((p) => p.includes('MULTI_LAYER_MOUNT_ENABLED = true'))).toBe(true);
  });

  it('fails when the mount flag is OFF while the docs say mounting is enabled', () => {
    // The real docs state mounting is enabled; flip only the shipped flag to
    // false to reproduce the inverse contradiction.
    const svc = realRead(SERVICE)!.replace(
      'MULTI_LAYER_MOUNT_ENABLED = true',
      'MULTI_LAYER_MOUNT_ENABLED = false',
    );
    const problems = problemsFor(withOverride(SERVICE, svc));
    expect(problems.some((p) => p.includes('MULTI_LAYER_MOUNT_ENABLED = false'))).toBe(true);
  });

  // The two phrases below are the wording v0.6.6 actually shipped with before
  // PR #438 corrected it, not invented examples. The rule guards the direction
  // a correction can be lost in: a release that lists what it added while a
  // surface still claims the application came forward untouched.
  describe('rule 6b — a blanket "unchanged" claim beside a populated Added list', () => {
    it('fails when the release notes claim the application came forward unchanged', () => {
      const doc = realRead(RELEASE_NOTES)! + '\n\nIt carries the v0.6.5 application forward unchanged.\n';
      const problems = problemsFor(withOverride(RELEASE_NOTES, doc));
      expect(problems.some((p) => p.includes('application forward unchanged'))).toBe(true);
    });

    it('fails when the changelog claims the algorithms are inherited unchanged', () => {
      // Inject the blanket claim into the CURRENT release section (the first
      // "### Changed", which is the top-most/current version) so rule 6b, which
      // scopes to the current version, sees it regardless of which version is cut.
      const text = realRead('CHANGELOG.md')!.replace(
        '### Changed\n',
        '### Changed\n\n- The terrain and measurement algorithms are inherited from v0.6.5 unchanged.\n',
      );
      const problems = problemsFor(withOverride('CHANGELOG.md', text));
      expect(problems.some((p) => p.includes('inherited from v0.6.5'))).toBe(true);
    });

    it('fails when the public release page carries the claim', () => {
      const doc = (realRead(DOCS_SITE) ?? '') + '\n\nThis is the v0.6.5 application, unchanged.\n';
      const problems = problemsFor(withOverride(DOCS_SITE, doc));
      expect(problems.some((p) => p.includes(DOCS_SITE))).toBe(true);
    });

    it('leaves a scoped "unchanged" statement alone', () => {
      // "contour geometry is unchanged ... unless the mode is selected" is true
      // and must stay sayable, or the rule would push writers toward vaguer prose.
      const doc =
        realRead(RELEASE_NOTES)! +
        '\n\nContour geometry is unchanged for every existing purpose unless the mode is selected.\n';
      expect(problemsFor(withOverride(RELEASE_NOTES, doc))).toEqual([]);
    });
  });
});
