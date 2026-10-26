/**
 * freezeProseLint.test.ts — the rules in scripts/lint-freeze-prose.mjs.
 *
 * Four register entries described a tolerance as preregistered while the
 * protocol governing the claim recorded adopted-with-result, and no check
 * compared the two. The cases below drive the rules through synthetic records
 * so they describe the rules rather than whatever the repository holds today;
 * one case runs the real tree.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - plain .mjs script, no types
import { assertedStatuses, freezeStatusesByClaim, registerProblems, matrixProblems, testEntryMatches, lintFreezeProse } from '../scripts/lint-freeze-prose.mjs';
// @ts-expect-error - plain .mjs script, no types
import { serialOrder } from '../scripts/lib/gates.mjs';

const protocols = (status: string, claimId = 'AREA') => [
  { protocolId: 'P', claims: [{ claimId, freeze: { status } }] },
];
const register = (prose: string, claimId = 'AREA', tests = 'tests/area.test.ts') =>
  `claims:\n  - claimId: ${claimId}\n    supportingTests: [${tests}]\n    approvedClaim: "${prose}"\n`;

describe('assertedStatuses', () => {
  it('reads a positive mention of either status', () => {
    expect([...assertedStatuses('within the preregistered 1e-6 tolerance')]).toEqual(['preregistered']);
    expect([...assertedStatuses('a tolerance adopted with the result')]).toEqual(['adopted-with-result']);
    expect([...assertedStatuses('the freeze is adopted-with-result')]).toEqual(['adopted-with-result']);
  });

  it('does not read a denial as an assertion', () => {
    expect([...assertedStatuses('a tolerance carried over rather than preregistered')]).toEqual([]);
    expect([...assertedStatuses('(not preregistered)')]).toEqual([]);
    expect([...assertedStatuses('fixed without a preregistered gate')]).toEqual([]);
  });

  it('keeps a positive mention beside a denial elsewhere in the text', () => {
    const t = 'within the preregistered tolerance; the end caps were carried over rather than preregistered';
    expect([...assertedStatuses(t)]).toEqual(['preregistered']);
  });
});

describe('F1 and F2 over the register', () => {
  it('F1: "preregistered" prose against an adopted-with-result protocol', () => {
    const p = registerProblems(register('within the preregistered 1e-6 tolerance'), freezeStatusesByClaim(protocols('adopted-with-result')));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/AREA.*describes a preregistered tolerance.*records adopted-with-result/);
  });

  it('F2: "adopted with the result" prose against a preregistered protocol', () => {
    const p = registerProblems(register('a 1e-6 tolerance adopted with the result'), freezeStatusesByClaim(protocols('preregistered')));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/adopted with its result.*records preregistered/);
  });

  it('passes prose that says what the protocol carries, and skips a claim with no protocol', () => {
    expect(registerProblems(register('a 1e-6 tolerance adopted with the result, not preregistered'), freezeStatusesByClaim(protocols('adopted-with-result')))).toEqual([]);
    expect(registerProblems(register('within the preregistered tolerance', 'OTHER'), freezeStatusesByClaim(protocols('adopted-with-result')))).toEqual([]);
  });

  it('ignores an example protocol', () => {
    const byClaim = freezeStatusesByClaim([{ example: true, claims: [{ claimId: 'AREA', freeze: { status: 'preregistered' } }] }]);
    expect(byClaim.size).toBe(0);
  });
});

describe('F3 over the matrix', () => {
  const byClaim = freezeStatusesByClaim(protocols('adopted-with-result', 'CHM'));
  const yaml = register('x', 'CHM', 'tests/chm*.test.ts');

  it('maps a row to its claims through the test files it cites, globs included', () => {
    const md = '| CHM | within the preregistered 0.1 m tolerance | `tests/chmCrossCheck.test.ts` | E4 |';
    const p = matrixProblems(md, yaml, byClaim);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/terrain-validation-matrix\.md:1 describes a preregistered tolerance/);
  });

  it('passes a row whose words match, and a row citing no test file', () => {
    expect(matrixProblems('| CHM | adopted with the result | `tests/chmCrossCheck.test.ts` | E4 |', yaml, byClaim)).toEqual([]);
    expect(matrixProblems('| CHM | preregistered | none | E4 |', yaml, byClaim)).toEqual([]);
  });

  it('testEntryMatches handles exact names and globs', () => {
    expect(testEntryMatches('tests/measure*.test.ts', 'tests/measureAreaCrossCheck.test.ts')).toBe(true);
    expect(testEntryMatches('tests/measure*.test.ts', 'tests/profile.test.ts')).toBe(false);
    expect(testEntryMatches('tests/a.test.ts', 'tests/a.test.ts')).toBe(true);
  });
});

describe('the real tree and the wiring', () => {
  it('the committed register and matrix agree with the protocol records', () => {
    const { problems, governed } = lintFreezeProse();
    expect(governed).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it('the release chain runs it', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['lint:freeze-prose']).toBe('node scripts/lint-freeze-prose.mjs');
    expect(serialOrder(), 'a lint outside the release chain guards nothing at release time').toContain('lint:freeze-prose');
  });
});
