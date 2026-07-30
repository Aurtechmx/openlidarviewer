/**
 * defectReplayStates.test.ts
 *
 * The defect replay's state derivation, pinned at the two points where it used
 * to overstate what a probe had shown.
 *
 *  1. A probe that passes on BOTH trees demonstrates nothing about the old
 *     behaviour. It used to share the `inconclusive` bucket with pairs that
 *     produced no readable result, which reads as a run that went wrong rather
 *     than as a probe that cannot bear on the record. It is now
 *     `non-discriminating`, and a record whose only executable probe is one of
 *     those never reads `reproduced-then-fixed`.
 *
 *  2. A baseline failure that is only "the imported binding is not a function"
 *     established that the fix's own helper did not exist yet. It observed no
 *     behaviour, so it is `component-absent-at-baseline` rather than a
 *     reproduction. The narrow form matters: a method call on a runtime object
 *     produces the same words and IS a behavioural failure, so the two cases
 *     are asserted apart from each other.
 *
 * These are the checks that stop the aggregate from drifting back up: nothing
 * else fails if `deriveState` starts calling a both-sides-pass a reproduction.
 */
import { describe, it, expect } from 'vitest';
// The directive has to sit on the line the error is reported on, so this import
// stays on one line: a wrapped form puts the module specifier on line 3 and the
// suppression on line 1, and tsc then reports both an unused directive and the
// missing declaration file.
// @ts-expect-error — plain .mjs script, no types
import { deriveState, deriveDefectState, STATES, DEFECT_STATE_PRECEDENCE } from '../scripts/defect-replay-lib.mjs';

type Assertion = { fullName: string; status: string; failureMessages: string[] };

/** A raw record shaped like the runner writes one, for a vitest-case probe. */
function record(
  label: 'baseline' | 'candidate',
  assertions: Assertion[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const failed = assertions.filter((a) => a.status === 'failed').length;
  return {
    defect: 'OLV-DEF-000',
    probeIndex: 0,
    probeKind: 'vitest-case',
    probeFile: 'tests/example.test.ts',
    probeCase: 'the case',
    environment: { label, commit: 'a'.repeat(40) },
    command: 'npx vitest run tests/example.test.ts',
    exitCode: failed > 0 ? 1 : 0,
    timedOut: false,
    durationMs: 10,
    transcript: `Tests  ${failed > 0 ? `${failed} failed | ` : ''}${assertions.length - failed} passed (${assertions.length})`,
    reporterJson: JSON.stringify({
      success: failed === 0,
      numTotalTests: assertions.length,
      numFailedTests: failed,
      testResults: [{ assertionResults: assertions }],
    }),
    ...overrides,
  };
}

const passing: Assertion = { fullName: 'the case', status: 'passed', failureMessages: [] };
const valueFailure: Assertion = {
  fullName: 'the case',
  status: 'failed',
  failureMessages: ["AssertionError: expected 'metre' to be 'unknown' // Object.is equality"],
};
// The exact shape vitest reports when a probe calls a binding the tree does not
// export: the vite SSR transform names the import wrapper.
const absentBinding: Assertion = {
  fullName: 'the case',
  status: 'failed',
  failureMessages: ['TypeError: (0 , __vite_ssr_import_2__.verticalUnitGeoKeyCode) is not a function'],
};
// Same words, no import wrapper: a method call against a runtime object, which
// is an ordinary behavioural failure.
const runtimeCallFailure: Assertion = {
  fullName: 'the case',
  status: 'failed',
  failureMessages: ['TypeError: result.toGeoJSON is not a function'],
};

const probe = { defect: 'OLV-DEF-000', index: 0, kind: 'vitest-case', file: 'tests/example.test.ts', case: 'the case', reason: null };

describe('defect replay state derivation', () => {
  it('calls a probe that passes on both trees non-discriminating, not inconclusive', () => {
    const state = deriveState(probe, record('baseline', [passing]), record('candidate', [passing]));
    expect(state.state).toBe('non-discriminating');
    expect(state.state).not.toBe('inconclusive');
    expect(state.why).toContain('demonstrates nothing');
  });

  it('counts a baseline value failure against a passing candidate as a reproduction', () => {
    const state = deriveState(probe, record('baseline', [valueFailure]), record('candidate', [passing]));
    expect(state.state).toBe('reproduced-then-fixed');
  });

  it('does not read an absent binding at the baseline as a reproduction', () => {
    const state = deriveState(probe, record('baseline', [absentBinding]), record('candidate', [passing]));
    expect(state.state).toBe('component-absent-at-baseline');
    expect(state.why).toContain('verticalUnitGeoKeyCode');
  });

  it('keeps the behavioural reading when a probe failed on a value as well as on an absent binding', () => {
    const baseline = record('baseline', [
      { ...absentBinding, fullName: 'the case one' },
      { ...valueFailure, fullName: 'the case two' },
    ]);
    // Both cases are selected: `probeCase` is a substring of each full name.
    const state = deriveState({ ...probe, case: 'the case' }, baseline, record('candidate', [passing]));
    expect(state.state).toBe('reproduced-then-fixed');
  });

  it('treats a failed call on a runtime object as behaviour, not as an absent binding', () => {
    const state = deriveState(probe, record('baseline', [runtimeCallFailure]), record('candidate', [passing]));
    expect(state.state).toBe('reproduced-then-fixed');
  });

  it('leaves a candidate that does not pass inconclusive, whatever the baseline did', () => {
    const state = deriveState(probe, record('baseline', [valueFailure]), record('candidate', [valueFailure]));
    expect(state.state).toBe('inconclusive');
  });

  it('does not let a record read as reproduced when its only executable probe passed on both trees', () => {
    const probes = [
      { defect: 'OLV-DEF-000', index: 0, kind: 'none', file: 'x', case: null, reason: 'prose' },
      probe,
    ];
    const records = [
      record('baseline', [passing], { probeIndex: 0 }),
      record('candidate', [passing], { probeIndex: 0 }),
    ];
    expect(deriveDefectState('OLV-DEF-000', probes, records)).toBe('non-discriminating');
  });

  it('ranks every state exactly once, so no state can go missing from a record', () => {
    expect([...DEFECT_STATE_PRECEDENCE].sort()).toEqual([...STATES].sort());
  });
});
