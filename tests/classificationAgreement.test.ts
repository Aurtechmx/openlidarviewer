/**
 * classificationAgreement.test.ts
 *
 * Exercises the label-agreement maths with SYNTHETIC labels. It proves the
 * metrics are correct; it validates no ground filter and supports no claim.
 *
 * The MCC convention at the degenerate margins is pinned here, because a change
 * to it would silently alter every reported coefficient.
 */

import { describe, it, expect } from 'vitest';
import {
  classificationAgreement,
  MCC_DEGENERATE_VALUE,
  type ClassLabel,
} from '../src/validation/classificationAgreement';

const G: ClassLabel = 'ground';
const N: ClassLabel = 'non-ground';
const A: ClassLabel = 'ambiguous';
const U: ClassLabel = 'unclassified';

describe('classificationAgreement metrics', () => {
  // tp = 4, fp = 1, fn = 2, tn = 3.
  const truth: ClassLabel[] = [G, G, G, G, G, G, N, N, N, N];
  const pred: ClassLabel[] = [G, G, G, G, N, N, G, N, N, N];

  it('reports a hand-checked confusion matrix and every derived metric', () => {
    const r = classificationAgreement(truth, pred);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.confusion).toEqual({
      truePositive: 4,
      falsePositive: 1,
      falseNegative: 2,
      trueNegative: 3,
    });
    expect(r.evaluated).toBe(10);
    expect(r.groundPrecision).toBeCloseTo(4 / 5, 12);
    expect(r.groundRecall).toBeCloseTo(4 / 6, 12);
    expect(r.groundF1).toBeCloseTo(8 / 11, 12);
    expect(r.nonGroundPrecision).toBeCloseTo(3 / 5, 12);
    expect(r.nonGroundRecall).toBeCloseTo(3 / 4, 12);
    expect(r.balancedAccuracy).toBeCloseTo((4 / 6 + 3 / 4) / 2, 12);
    expect(r.groundIoU).toBeCloseTo(4 / 7, 12);
    // (4x3 - 1x2) / sqrt(5 x 6 x 4 x 5)
    expect(r.mcc).toBeCloseTo(10 / Math.sqrt(600), 12);
    expect(r.mccDegenerate).toBe(false);
  });

  it('reaches 1 on perfect agreement with both classes present', () => {
    const r = classificationAgreement([G, G, N, N], [G, G, N, N]);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.mcc).toBeCloseTo(1, 12);
    expect(r.groundF1).toBe(1);
    expect(r.balancedAccuracy).toBe(1);
    expect(r.groundIoU).toBe(1);
    expect(r.mccDegenerate).toBe(false);
  });

  it('reaches -1 on perfect disagreement', () => {
    const r = classificationAgreement([G, G, N, N], [N, N, G, G]);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.mcc).toBeCloseTo(-1, 12);
  });

  it('returns null, not 0, for a metric with an empty denominator', () => {
    // Nothing was predicted ground, so ground precision was never measured;
    // recall WAS measured and is a real 0.
    const r = classificationAgreement([G, N], [N, N]);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.groundPrecision).toBeNull();
    expect(r.groundRecall).toBe(0);
    expect(r.groundIoU).toBe(0);
  });
});

describe('classificationAgreement ambiguity and abstention', () => {
  it('excludes ambiguous pairs from binary metrics and counts them', () => {
    const truth: ClassLabel[] = [G, G, A, N, N];
    const pred: ClassLabel[] = [G, G, N, N, N];
    const r = classificationAgreement(truth, pred);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.pairs).toBe(5);
    expect(r.evaluated).toBe(4);
    expect(r.ambiguousCount).toBe(1);
    expect(r.abstainedCount).toBe(0);
    expect(r.confusion).toEqual({
      truePositive: 2,
      falsePositive: 0,
      falseNegative: 0,
      trueNegative: 2,
    });
    // The ambiguous cell was NOT forced into non-ground: doing so would have
    // added a true negative and inflated the coefficient.
    expect(r.mcc).toBeCloseTo(1, 12);
  });

  it('counts an ambiguous prediction as well as an ambiguous truth', () => {
    const r = classificationAgreement([G, N, G, N], [A, A, G, N]);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.ambiguousCount).toBe(2);
    expect(r.evaluated).toBe(2);
  });

  it('counts unclassified pairs as abstentions, separately from ambiguity', () => {
    const r = classificationAgreement([G, G, N, N, U], [G, U, N, N, N]);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.abstainedCount).toBe(2);
    expect(r.ambiguousCount).toBe(0);
    expect(r.evaluated).toBe(3);
  });

  it('attributes a pair that is both unclassified and ambiguous to abstention', () => {
    const r = classificationAgreement([A, G, N], [U, G, N]);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.abstainedCount).toBe(1);
    expect(r.ambiguousCount).toBe(0);
  });
});

describe('MCC at the degenerate margins', () => {
  it('is 0 and flagged when the reference holds a single class', () => {
    // Perfect agreement, but with one truth class a constant classifier is
    // indistinguishable from a good one, so no correlation is measurable.
    const r = classificationAgreement([G, G, G, G], [G, G, G, G]);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.mcc).toBe(MCC_DEGENERATE_VALUE);
    expect(r.mcc).toBe(0);
    expect(Number.isNaN(r.mcc)).toBe(false);
    expect(r.mccDegenerate).toBe(true);
    // The other metrics still report what they can.
    expect(r.groundPrecision).toBe(1);
    expect(r.groundRecall).toBe(1);
    expect(r.nonGroundPrecision).toBeNull();
    expect(r.nonGroundRecall).toBeNull();
    expect(r.balancedAccuracy).toBeNull();
  });

  it('is 0 and flagged when the classifier emits a single class', () => {
    const r = classificationAgreement([G, G, N, N], [G, G, G, G]);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.mcc).toBe(0);
    expect(r.mccDegenerate).toBe(true);
  });

  it('is 0 and flagged when both sides are entirely non-ground', () => {
    const r = classificationAgreement([N, N, N], [N, N, N]);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.mcc).toBe(0);
    expect(r.mccDegenerate).toBe(true);
  });

  it('distinguishes a genuine 0 from a degenerate one', () => {
    // tp = fp = fn = tn = 1: a real, measured zero correlation.
    const r = classificationAgreement([G, G, N, N], [G, N, G, N]);
    expect(r.status).toBe('compared');
    if (r.status !== 'compared') return;
    expect(r.mcc).toBe(0);
    expect(r.mccDegenerate).toBe(false);
  });
});

describe('classificationAgreement refusals', () => {
  it('refuses mismatched lengths', () => {
    const r = classificationAgreement([G, N], [G]);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('length-mismatch');
  });

  it('refuses empty input rather than reporting zeros', () => {
    const r = classificationAgreement([], []);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('empty-input');
  });

  it('refuses an unknown label', () => {
    const r = classificationAgreement([G, 'water' as ClassLabel], [G, N]);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('unknown-label');
    expect(r.detail).toContain('water');
  });

  it('refuses when every pair was excluded', () => {
    const r = classificationAgreement([A, U, A], [U, A, A]);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('no-binary-pairs');
  });

  it('refuses a sample below the caller minimum', () => {
    const r = classificationAgreement([G, N, A, A], [G, N, A, A], { minPairs: 3 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('below-min-pairs');
    expect(r.detail).toContain('3 required');
  });

  it('refuses a nonsensical minPairs', () => {
    const r = classificationAgreement([G, N], [G, N], { minPairs: 0 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('invalid-min-pairs');
  });
});
