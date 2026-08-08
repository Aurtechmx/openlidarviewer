/**
 * classificationEvidence.test.ts — the per-point evidence record + review rule.
 */

import { describe, it, expect } from 'vitest';
import { buildEvidence, isReviewUncertain } from '../src/classification/classificationEvidence';

describe('buildEvidence', () => {
  it('clamps support to [0,1] and carries reason codes', () => {
    expect(buildEvidence({ classCode: 2, source: 'derived', support: 1.7, methodVersion: 'v1' }).support).toBe(1);
    expect(buildEvidence({ classCode: 2, source: 'derived', support: -3, methodVersion: 'v1' }).support).toBe(0);
    const e = buildEvidence({ classCode: 6, source: 'derived', support: 0.8, methodVersion: 'v1', reasonCodes: ['PLANAR_HORIZONTAL'] });
    expect(e.reasonCodes).toEqual(['PLANAR_HORIZONTAL']);
  });

  it('flags low support, near-threshold and conflicting decisions', () => {
    const low = buildEvidence({ classCode: 5, source: 'derived', support: 0.3, methodVersion: 'v1' });
    expect(low.flags.lowSupport).toBe(true);
    const near = buildEvidence({ classCode: 5, source: 'derived', support: 0.55, methodVersion: 'v1', decisionThreshold: 0.5 });
    expect(near.flags.nearThreshold).toBe(true);
    const conflict = buildEvidence({ classCode: 5, source: 'derived', support: 0.6, methodVersion: 'v1', runnerUpSupport: 0.58 });
    expect(conflict.flags.conflicting).toBe(true);
  });
});

describe('isReviewUncertain — only weak DERIVED points are isolated', () => {
  it('a strong derived point is not flagged for review', () => {
    expect(isReviewUncertain(buildEvidence({ classCode: 6, source: 'derived', support: 0.95, methodVersion: 'v1' }))).toBe(false);
  });
  it('a weak derived point is flagged', () => {
    expect(isReviewUncertain(buildEvidence({ classCode: 6, source: 'derived', support: 0.2, methodVersion: 'v1' }))).toBe(true);
  });
  it('producer and manual classes are trusted and never review-isolated, even at low support', () => {
    expect(isReviewUncertain(buildEvidence({ classCode: 2, source: 'producer', support: 0.1, methodVersion: 'v1' }))).toBe(false);
    expect(isReviewUncertain(buildEvidence({ classCode: 2, source: 'manual', support: 0.1, methodVersion: 'v1' }))).toBe(false);
  });
});
