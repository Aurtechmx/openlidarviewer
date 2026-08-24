/**
 * datasetCitationLint.test.ts — proves the dataset-citation lint REJECTS, and
 * for the stated reason.
 *
 * Both rules guard a property that every other gate is blind to: the register's
 * own duplicate check compares whole ids, so it cannot see two records sharing
 * an ordinal, and nothing at all read prose for citations. A rule that cannot
 * fail looks identical, in a passing CI run, to a rule that works, so each rule
 * gets input it must reject and the assertion names the rule id.
 *
 * The register text here is synthetic, because these cases are about the rules.
 * The committed tree is checked by the CLI in CI and in the release gate.
 */
// lint-dataset-citations: synthetic-ids — the ids below are fixtures, not records.

import { describe, it, expect } from 'vitest';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { collectCitationProblems, parseDeclaredIds } from '../scripts/lint-dataset-citations.mjs';

interface Result { problems: string[]; cited: number; skipped: number; ordinals: number }

/** A register holding exactly the ids given, in order. */
function register(...ids: string[]): string {
  const body = ids
    .map((id) => `  - datasetId: ${id}\n    title: "${id}"\n    licence: CC-BY-4.0`)
    .join('\n');
  return `schemaVersion: 1\n\ndatasets:\n${body}\n`;
}

const REG = register(
  'OLV-DS-046-ANTIOCHIA-NS-FLIGHT1-QUICK',
  'OLV-DS-052-SCANCMP-TLS',
  'EXAMPLE-DS-001-ACQUIRED-COPC',
);

const run = (files: { path: string; text: string }[], reg = REG): Result =>
  collectCitationProblems(reg, files) as Result;

describe('dataset-citation lint — what it reads', () => {
  it('reads every datasetId in the register, template records included', () => {
    expect(parseDeclaredIds(REG)).toEqual([
      'OLV-DS-046-ANTIOCHIA-NS-FLIGHT1-QUICK',
      'OLV-DS-052-SCANCMP-TLS',
      'EXAMPLE-DS-001-ACQUIRED-COPC',
    ]);
  });

  it('counts only OLV-DS ordinals, so a template record is not one', () => {
    expect(run([]).ordinals).toBe(2);
  });
});

describe('D1 — one dataset per ordinal', () => {
  it('rejects two records sharing an ordinal, even with distinct full ids', () => {
    const reg = register('OLV-DS-046-SCANCMP-TLS', 'OLV-DS-046-ANTIOCHIA-NS-FLIGHT1-QUICK');
    const { problems } = run([], reg);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('[D1 ordinal-reused]');
    expect(problems[0]).toContain('ordinal 046');
    expect(problems[0]).toContain('OLV-DS-046-SCANCMP-TLS');
    expect(problems[0]).toContain('OLV-DS-046-ANTIOCHIA-NS-FLIGHT1-QUICK');
  });

  it('accepts distinct ordinals, which is the case D1 must not fire on', () => {
    expect(run([], register('OLV-DS-046-A', 'OLV-DS-047-B')).problems).toEqual([]);
  });
});

describe('D2 — every cited handle resolves', () => {
  it('rejects a full id that is in no record', () => {
    const { problems } = run([{ path: 'tests/x.test.ts', text: 'registered as OLV-DS-048-SCANCMP-LA03.' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('[D2 citation-dangling]');
    expect(problems[0]).toContain('tests/x.test.ts');
    expect(problems[0]).toContain('OLV-DS-048-SCANCMP-LA03');
  });

  it('names the record holding the ordinal, which is how a renumber is spotted', () => {
    const { problems } = run([{ path: 'r.md', text: 'see OLV-DS-046-SCANCMP-TLS' }]);
    expect(problems[0]).toContain('ordinal 046 is OLV-DS-046-ANTIOCHIA-NS-FLIGHT1-QUICK');
  });

  it('accepts a full id that resolves', () => {
    expect(run([{ path: 'r.md', text: 'see OLV-DS-052-SCANCMP-TLS' }]).problems).toEqual([]);
  });

  it('accepts a bare ordinal, which resolves through the record that holds it', () => {
    expect(run([{ path: 'r.md', text: 'see OLV-DS-052 for the scan' }]).problems).toEqual([]);
  });

  it('rejects a bare ordinal no record holds', () => {
    const { problems } = run([{ path: 'r.md', text: 'see OLV-DS-099' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('OLV-DS-099');
  });

  it('reports one problem per distinct handle, not per occurrence', () => {
    const text = 'OLV-DS-048-X and again OLV-DS-048-X and OLV-DS-049-Y';
    expect(run([{ path: 'r.md', text }]).problems).toHaveLength(2);
  });

  it('skips a file that declares synthetic ids, and says it skipped one', () => {
    const text = '// lint-dataset-citations: synthetic-ids\nconst id = "OLV-DS-999-IMAGINARY";';
    const result = run([{ path: 'tests/fake.test.ts', text }]);
    expect(result.problems).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('counts citations it checked, so a silent zero-match regex is visible', () => {
    expect(run([{ path: 'r.md', text: 'OLV-DS-052-SCANCMP-TLS twice: OLV-DS-052' }]).cited).toBe(2);
  });
});
