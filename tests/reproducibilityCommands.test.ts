/**
 * reproducibilityCommands.test.ts — the reproduction instructions name commands
 * that exist, and describe the gate the gate script actually is.
 *
 * REPRODUCIBILITY_v0.6.8.md told a reader to run `npm run gate` for "the whole
 * battery". `scripts/gate.sh` defaults to OLV_GATE_MODE=development, which runs
 * the static gate and nothing else: no e2e, no docs build, no production audit,
 * no fixture checksums, no coverage. The published coverage and e2e figures come
 * from release mode, which only .github/workflows/release.yml selected. The same
 * document was internally inconsistent about it — one row already said "a
 * blocking stage of the release-mode gate" while the instructions above never
 * mentioned that a mode existed.
 *
 * Nothing checked the prose against the script, so this does. It reads the
 * stages out of gate.sh rather than restating them, which is the only version of
 * this check that cannot itself go stale.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

/** The documents that tell a reader what to run to reproduce a published figure. */
const DOCS = ['docs/releases/REPRODUCIBILITY_v0.6.8.md', 'REVIEWER_QUICKSTART.md'] as const;

const GATE_SH = 'scripts/gate.sh';

/** The gate's default mode, read from the script's own parameter expansion. */
function defaultMode(gate: string): string {
  const m = /MODE="\$\{OLV_GATE_MODE:-(\w+)\}"/.exec(gate);
  expect(m, `${GATE_SH} no longer sets MODE from OLV_GATE_MODE`).not.toBeNull();
  return (m as RegExpExecArray)[1];
}

/**
 * Stage names, split by whether the mode gate guards them. Everything after
 * `if [[ "$MODE" = "release" ]]` runs only in release mode.
 */
function stages(gate: string): { always: string[]; releaseOnly: string[] } {
  const split = gate.indexOf('if [[ "$MODE" = "release" ]]');
  expect(split, `${GATE_SH} no longer branches on the release mode`).toBeGreaterThan(0);
  const names = (text: string): string[] =>
    [...text.matchAll(/^\s*run_stage\s+(\w+)/gm)].map((m) => m[1]);
  return { always: names(gate.slice(0, split)), releaseOnly: names(gate.slice(split)) };
}

describe('the reproduction instructions match the gate script', () => {
  const gate = read(GATE_SH);

  it('names the mode the gate actually defaults to', () => {
    const mode = defaultMode(gate);
    const doc = read(DOCS[0]);
    expect(doc, `the doc does not say that "${mode}" is the default mode`)
      .toMatch(new RegExp(`${mode}[^\\n]*\\bdefault\\b|\\bdefault\\b[^\\n]*${mode}`, 'i'));
    // And it must not present the default as running everything, which is the
    // claim that was false: the default runs one stage of six.
    expect(doc).toContain('OLV_GATE_MODE=release npm run gate');
  });

  it('lists every stage that only release mode runs', () => {
    const { always, releaseOnly } = stages(gate);
    expect(always.length, 'no unconditional gate stage found').toBeGreaterThan(0);
    expect(releaseOnly.length, 'no release-only gate stage found').toBeGreaterThan(0);
    const doc = read(DOCS[0]).toLowerCase();
    // The stage names are camelCase in the script and prose in the document, so
    // match on the distinguishing word rather than the identifier.
    const word: Record<string, string> = {
      e2e: 'e2e',
      docsBuild: 'documentation build',
      productionAudit: 'production audit',
      fixtureChecksums: 'fixture checksum',
      coverage: 'coverage',
      mutation: 'mutation',
    };
    for (const stage of releaseOnly) {
      const needle = word[stage];
      expect(needle, `gate.sh gained a release-only stage "${stage}" with no known wording`)
        .toBeDefined();
      expect(doc, `the doc never mentions the release-only stage "${stage}"`)
        .toContain(needle);
    }
  });

  it('does not credit a non-gate command with the GATE EXIT line', () => {
    // Only gate.sh writes it. The verification table used to point at
    // `npm run test:release`, which is the static stage the gate runs first and
    // prints no such line.
    expect(gate).toContain('echo "GATE EXIT: ${OVERALL}"');
    for (const path of DOCS) {
      for (const line of read(path).split('\n')) {
        if (!line.includes('GATE EXIT')) continue;
        // A line that DENIES a command prints it is the correction, not the defect.
        if (/\bno\b[^.]*GATE EXIT|not a gate run|prints none/i.test(line)) continue;
        const claimsAScript = /`npm run ([\w:]+)`/.exec(line);
        if (claimsAScript === null) continue;
        expect(claimsAScript[1], `${path} credits "npm run ${claimsAScript[1]}" with the GATE EXIT line`)
          .toBe('gate');
      }
    }
  });

  it('names only npm scripts that exist', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    for (const path of DOCS) {
      const named = new Set(
        [...read(path).matchAll(/npm run ([A-Za-z0-9:_.-]+)/g)]
          .map((m) => m[1].replace(/[.,]+$/, '')),
      );
      for (const name of named) {
        expect(scripts, `${path} tells a reader to run "npm run ${name}", which package.json does not define`)
          .toHaveProperty(name);
      }
    }
  });
});
