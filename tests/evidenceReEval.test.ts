/**
 * evidenceReEval.test.ts — re-evaluating evidence never promotes a claim.
 *
 * The project's non-negotiable rule is that evidence rises only when a real,
 * independent reference is supplied — never as a side effect of re-running the
 * assessment. These tests pin that the evaluation surface is idempotent and
 * one-directional: repeating a check with the same inputs yields the same level
 * and the same export decision, a self-verified level cannot cross the
 * independence floor by repetition, and a pending cross-check (no reference
 * supplied) stays pending no matter how often it is asked.
 */

import { describe, it, expect } from 'vitest';
import {
  meetsRequired, isSelfVerified, exportDecision, INDEPENDENCE_FLOOR, evidenceRank,
} from '../src/validation/evidenceLevel';
import { crossCheck, pendingCrossCheck } from '../src/validation/crossCheck';

describe('the export decision is idempotent — re-asking never upgrades', () => {
  it('a below-required level is exploratory-only, and stays so on every repeat', () => {
    const decide = () => exportDecision('E3_SYNTHETICALLY_VALIDATED', 'E4_CROSS_IMPLEMENTATION_VALIDATED', true);
    const first = decide();
    expect(first.allowed).toBe(false);
    expect(first.exploratoryOnly).toBe(true);
    // Ten re-evaluations cannot turn an exploratory artifact into a validated one.
    for (let i = 0; i < 10; i++) expect(decide()).toEqual(first);
  });

  it('meeting the requirement is a pure function of the two levels, not of call count', () => {
    expect(meetsRequired('E4_CROSS_IMPLEMENTATION_VALIDATED', 'E4_CROSS_IMPLEMENTATION_VALIDATED')).toBe(true);
    expect(meetsRequired('E3_SYNTHETICALLY_VALIDATED', 'E4_CROSS_IMPLEMENTATION_VALIDATED')).toBe(false);
    // Repeating the below-required check never flips it true.
    for (let i = 0; i < 5; i++) {
      expect(meetsRequired('E3_SYNTHETICALLY_VALIDATED', 'E4_CROSS_IMPLEMENTATION_VALIDATED')).toBe(false);
    }
  });
});

describe('crossing the independence floor requires a strictly higher level, not a re-run', () => {
  it('a self-verified level stays self-verified however often it is evaluated', () => {
    for (let i = 0; i < 5; i++) expect(isSelfVerified('E3_SYNTHETICALLY_VALIDATED')).toBe(true);
    expect(isSelfVerified(INDEPENDENCE_FLOOR)).toBe(false);
    // The floor is genuinely above the self-verified tiers.
    expect(evidenceRank(INDEPENDENCE_FLOOR)).toBeGreaterThan(evidenceRank('E3_SYNTHETICALLY_VALIDATED'));
  });
});

describe('a cross-check with no reference cannot manufacture agreement', () => {
  it('pendingCrossCheck stays pending on every call', () => {
    for (let i = 0; i < 3; i++) expect(pendingCrossCheck().verdict).toBe('pending');
  });

  it('the only path to "agree" is a real reference that actually matches — not an empty one', () => {
    // No comparable cells (reference all-nodata) can never read as agreement; it
    // is insufficient, the honest verdict. Agreement demands real matching data.
    const ours = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const emptyRef = new Array(10).fill(NaN);
    expect(crossCheck(ours, emptyRef, { toleranceAbs: 0.01 }).verdict).toBe('insufficient');
    // A genuine matching reference is what promotes — and it is deterministic.
    const realRef = [...ours];
    const r1 = crossCheck(ours, realRef, { toleranceAbs: 0.01 });
    const r2 = crossCheck(ours, realRef, { toleranceAbs: 0.01 });
    expect(r1.verdict).toBe('agree');
    expect(r2).toEqual(r1);
  });
});
