/**
 * evidenceMonotonicity.test.ts — a derived product may not out-rank its source.
 */

import { describe, it, expect } from 'vitest';
import {
  READINESS_LADDER,
  COVERAGE_LADDER,
  isValidEvidenceTransition,
  isValidCoverageTransition,
  validateChain,
} from '../src/validation/evidenceMonotonicity';

describe('evidence transitions', () => {
  it('allows staying or weakening', () => {
    expect(isValidEvidenceTransition(READINESS_LADDER, 'Ready', 'Ready')).toBe(true);
    expect(isValidEvidenceTransition(READINESS_LADDER, 'Ready', 'Preview')).toBe(true);
    expect(isValidEvidenceTransition(READINESS_LADDER, 'Preview', 'Blocked')).toBe(true);
  });
  it('forbids strengthening', () => {
    expect(isValidEvidenceTransition(READINESS_LADDER, 'Preview', 'Ready')).toBe(false);
    expect(isValidEvidenceTransition(READINESS_LADDER, 'Blocked', 'Ready')).toBe(false);
    expect(isValidEvidenceTransition(READINESS_LADDER, 'Blocked', 'Preview')).toBe(false);
  });
  it('fails closed on an unknown source, and never lets a known state out-rank it', () => {
    // Unknown source with a KNOWN target → invalid (can't prove the target isn't a promotion).
    expect(isValidEvidenceTransition(READINESS_LADDER, 'Mystery', 'Ready')).toBe(false);
    // Unknown target cannot out-rank anything → allowed.
    expect(isValidEvidenceTransition(READINESS_LADDER, 'Ready', 'Mystery')).toBe(true);
  });
});

describe('coverage transitions (source-universe completeness)', () => {
  it('never promotes resident-only or sampled to full', () => {
    expect(isValidCoverageTransition('resident-only', 'full')).toBe(false);
    expect(isValidCoverageTransition('resident-only', 'sampled')).toBe(false);
    expect(isValidCoverageTransition('sampled', 'full')).toBe(false);
  });
  it('allows staying or narrowing coverage', () => {
    expect(isValidCoverageTransition('full', 'full')).toBe(true);
    expect(isValidCoverageTransition('full', 'sampled')).toBe(true);
    expect(isValidCoverageTransition('sampled', 'resident-only')).toBe(true);
  });
  it('the ladder is ordered most-complete first', () => {
    expect(COVERAGE_LADDER[0]).toBe('full');
    expect(COVERAGE_LADDER[COVERAGE_LADDER.length - 1]).toBe('resident-only');
  });
});

describe('validateChain — a whole derivation', () => {
  it('passes a monotone-weakening chain: point support → DTM → slope → contours', () => {
    const r = validateChain(READINESS_LADDER, ['Ready', 'Ready', 'Preview', 'Preview']);
    expect(r.valid).toBe(true);
  });
  it('flags the exact link where authority is manufactured', () => {
    // ...Preview → Ready at index 3 is the illegal upgrade.
    const r = validateChain(READINESS_LADDER, ['Ready', 'Preview', 'Preview', 'Ready']);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(3);
  });
  it('a smoothed/generalised contour cannot exceed the analytical contour it came from', () => {
    expect(validateChain(READINESS_LADDER, ['Preview', 'Ready']).valid).toBe(false);
  });
});
