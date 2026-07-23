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
const KNOWN = `KNOWN_LIMITATIONS_v${VERSION}.md`;
const VALREPORT = `VALIDATION_REPORT_v${VERSION}.md`;
const CLAIMS = 'docs/validation/claim-register.yaml';
const DEPS = 'DEPENDENCIES.md';
const NOTICES = 'THIRD_PARTY_NOTICES.md';
const CHECKLIST = 'RELEASE_CHECKLIST.md';

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

  it('fails on a prior-release present-tense mounting claim', () => {
    // Version-agnostic: corrupt whatever the CURRENT doc says into a stale
    // prerelease identifier — the rule must flag it at stable versions too.
    const doc = realRead(KNOWN)!.replace(/DISABLED in [\w.]+/, 'DISABLED in alpha.2');
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

  it('fails on a stale dependency-audit version heading', () => {
    const doc = realRead(DEPS)!.replace(
      `# Dependency audit — v${VERSION}`,
      '# Dependency audit — v0.5.9',
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
    const doc = realRead(DEPS)!.replace(/22\.17\.1/g, '26.0.0');
    const problems = problemsFor(withOverride(DEPS, doc));
    expect(problems.some((p) => p.includes('canonical Node'))).toBe(true);
  });

  it('fails when the release checklist drops a required asset', () => {
    const doc = realRead(CHECKLIST)!.replace(/sbom\.json/gi, 'REMOVED');
    const problems = problemsFor(withOverride(CHECKLIST, doc));
    expect(problems.some((p) => p.includes('sbom.json'))).toBe(true);
  });
});
