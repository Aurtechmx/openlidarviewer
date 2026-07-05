/**
 * evidenceLevel.test.ts
 *
 * Pins the evidence ladder (research-hardening Phase 1): ordering, the
 * required-level gate, the independence floor, and the export decision (a
 * below-required product is exploratory-only, an export-disabled product is
 * never offered).
 */

import { describe, it, expect } from 'vitest';
import {
  EVIDENCE_LEVELS,
  evidenceRank,
  meetsRequired,
  isSelfVerified,
  evidenceLabel,
  evidenceBadge,
  exportDecision,
  INDEPENDENCE_FLOOR,
} from '../src/validation/evidenceLevel';

describe('evidence ladder', () => {
  it('is strictly increasing and gapless', () => {
    for (let i = 1; i < EVIDENCE_LEVELS.length; i++) {
      expect(evidenceRank(EVIDENCE_LEVELS[i])).toBe(evidenceRank(EVIDENCE_LEVELS[i - 1]) + 1);
    }
  });

  it('meetsRequired compares rank, not equality', () => {
    expect(meetsRequired('E3_SYNTHETICALLY_VALIDATED', 'E1_UNIT_VERIFIED')).toBe(true);
    expect(meetsRequired('E2_ANALYTICALLY_VERIFIED', 'E2_ANALYTICALLY_VERIFIED')).toBe(true);
    expect(meetsRequired('E3_SYNTHETICALLY_VALIDATED', 'E5_EXTERNALLY_VALIDATED')).toBe(false);
  });

  it('everything below E4 is self-verified; E4+ is independent', () => {
    expect(INDEPENDENCE_FLOOR).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    expect(isSelfVerified('E3_SYNTHETICALLY_VALIDATED')).toBe(true);
    expect(isSelfVerified('E4_CROSS_IMPLEMENTATION_VALIDATED')).toBe(false);
    expect(isSelfVerified('E5_EXTERNALLY_VALIDATED')).toBe(false);
  });

  it('labels never reuse "Production" and badges map sensibly', () => {
    for (const l of EVIDENCE_LEVELS) expect(evidenceLabel(l)).not.toMatch(/production/i);
    expect(evidenceBadge('E0_IMPLEMENTED')).toBe('Not assessed');
    expect(evidenceBadge('E2_ANALYTICALLY_VERIFIED')).toBe('Analytic');
    expect(evidenceBadge('E3_SYNTHETICALLY_VALIDATED')).toBe('Synthetic');
    expect(evidenceBadge('E5_EXTERNALLY_VALIDATED')).toBe('External');
  });
});

describe('exportDecision gate', () => {
  it('allows a met requirement', () => {
    expect(exportDecision('E3_SYNTHETICALLY_VALIDATED', 'E3_SYNTHETICALLY_VALIDATED', true)).toEqual({
      allowed: true,
      exploratoryOnly: false,
      reason: '',
    });
  });

  it('makes a below-required product exploratory-only, with a reason', () => {
    const d = exportDecision('E3_SYNTHETICALLY_VALIDATED', 'E5_EXTERNALLY_VALIDATED', true);
    expect(d.allowed).toBe(false);
    expect(d.exploratoryOnly).toBe(true);
    expect(d.reason).toMatch(/exploratory/i);
  });

  it('never offers an export-disabled product, even exploratory', () => {
    const d = exportDecision('E1_UNIT_VERIFIED', 'E5_EXTERNALLY_VALIDATED', false);
    expect(d.allowed).toBe(false);
    expect(d.exploratoryOnly).toBe(false);
  });
});
