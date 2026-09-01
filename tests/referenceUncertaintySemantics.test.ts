/**
 * referenceUncertaintySemantics.test.ts
 *
 * A checkpoint accuracy figure may only combine the fit RMSE against a reference
 * uncertainty when the reference number is actually a 1-sigma standard
 * uncertainty. These tests pin the meaning-aware conversion: a value whose
 * meaning is not established is never taken as sigma, and no combined RMSE is
 * produced pretending it was.
 *
 * SYNTHETIC checkpoints only. This proves the semantics, not any product.
 */

import { describe, it, expect } from 'vitest';
import {
  checkpointAccuracy,
  referenceSigmaFromUncertainty,
  referenceUncertaintyFromValue,
  NORMAL_95_COVERAGE_FACTOR,
  type Checkpoint,
  type ReferenceUncertainty,
  type UncertaintyCombination,
} from '../src/validation/checkpointAccuracy';

function cp(id: string, residual: number, extra: Partial<Checkpoint> = {}): Checkpoint {
  return { id, reference: 100, measured: 100 + residual, usage: 'independent', ...extra };
}

const RESIDUALS: ReadonlyArray<[string, number]> = [
  ['a', 0.1],
  ['b', -0.05],
  ['c', 0.2],
  ['d', 0],
  ['e', -0.25],
];
const OBSERVED_RMSE = Math.sqrt(0.115 / 5);

const quadratureSum: UncertaintyCombination = {
  id: 'test-quadrature-sum-v1',
  combine: (observed, reference) => Math.sqrt(observed * observed + reference * reference),
};

function withMeaning(u: ReferenceUncertainty): Checkpoint[] {
  return RESIDUALS.map(([id, r]) => cp(id, r, { referenceUncertainty: u }));
}

describe('referenceSigmaFromUncertainty', () => {
  it('returns the value unchanged for a standard deviation', () => {
    expect(referenceSigmaFromUncertainty({ valueMetres: 0.03, meaning: 'standard-deviation', source: 's' })).toBe(0.03);
  });

  it('treats an RMSE as sigma under the zero-mean assumption', () => {
    expect(referenceSigmaFromUncertainty({ valueMetres: 0.04, meaning: 'rmse', source: 's' })).toBe(0.04);
  });

  it('divides a 95-percent figure by the normal coverage factor', () => {
    expect(referenceSigmaFromUncertainty({ valueMetres: 0.098, meaning: '95-percent', source: 's' })).toBeCloseTo(
      0.098 / NORMAL_95_COVERAGE_FACTOR,
      12,
    );
  });

  it('refuses to fabricate a sigma from a manufacturer bound or an unknown meaning', () => {
    expect(referenceSigmaFromUncertainty({ valueMetres: 0.05, meaning: 'manufacturer-bound', source: 's' })).toBeNull();
    expect(referenceSigmaFromUncertainty({ valueMetres: 0.05, meaning: 'unknown', source: 's' })).toBeNull();
  });
});

describe('referenceUncertaintyFromValue fail-closed default', () => {
  it('defaults a bare number to unknown meaning, never 1-sigma', () => {
    const u = referenceUncertaintyFromValue(0.05);
    expect(u.meaning).toBe('unknown');
    expect(referenceSigmaFromUncertainty(u)).toBeNull();
  });
});

describe('checkpointAccuracy reference-uncertainty semantics', () => {
  it('standard-deviation: referenceSigma == value and a combined RMSE is produced', () => {
    const r = checkpointAccuracy(
      withMeaning({ valueMetres: 0.03, meaning: 'standard-deviation', source: 'survey' }),
      { minSample: 5, uncertaintyCombination: quadratureSum },
    );
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    expect(r.pooled.referenceUncertaintyState).toBe('established');
    expect(r.pooled.referenceRmse).toBeCloseTo(0.03, 12);
    expect(r.pooled.combinedRmse).toBeCloseTo(Math.sqrt(OBSERVED_RMSE ** 2 + 0.03 ** 2), 12);
    expect(r.pooled.uncertaintyCombinationId).toBe('test-quadrature-sum-v1');
  });

  it('95-percent: referenceSigma == value / 1.96', () => {
    const value = 0.098;
    const r = checkpointAccuracy(
      withMeaning({ valueMetres: value, meaning: '95-percent', source: 'survey' }),
      { minSample: 5, uncertaintyCombination: quadratureSum },
    );
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    const sigma = value / NORMAL_95_COVERAGE_FACTOR;
    expect(r.pooled.referenceUncertaintyState).toBe('established');
    expect(r.pooled.referenceRmse).toBeCloseTo(sigma, 12);
    expect(r.pooled.combinedRmse).toBeCloseTo(Math.sqrt(OBSERVED_RMSE ** 2 + sigma ** 2), 12);
  });

  for (const meaning of ['unknown', 'manufacturer-bound'] as const) {
    it(`${meaning}: no sigma, no combined RMSE, not-established state, fit RMSE still reported`, () => {
      const r = checkpointAccuracy(
        withMeaning({ valueMetres: 0.05, meaning, source: 'spec' }),
        { minSample: 5, uncertaintyCombination: quadratureSum },
      );
      expect(r.status).toBe('reported');
      if (r.status !== 'reported') return;
      expect(r.pooled.referenceUncertaintyState).toBe('not-established');
      expect(r.pooled.referenceRmse).toBeNull();
      expect(r.pooled.combinedRmse).toBeNull();
      expect(r.pooled.uncertaintyCombinationId).toBeNull();
      // The fit RMSE stands alone rather than vanishing with the reference term.
      expect(r.pooled.rmse).toBeCloseTo(OBSERVED_RMSE, 12);
    });
  }

  it('one unknown-meaning checkpoint marks the whole group not-established (fail-closed)', () => {
    const mixed = [
      cp('a', 0.1, { referenceUncertainty: { valueMetres: 0.03, meaning: 'standard-deviation', source: 's' } }),
      cp('b', -0.05, { referenceUncertainty: { valueMetres: 0.05, meaning: 'unknown', source: 's' } }),
      cp('c', 0.2, { referenceUncertainty: { valueMetres: 0.03, meaning: 'standard-deviation', source: 's' } }),
      cp('d', 0, { referenceUncertainty: { valueMetres: 0.03, meaning: 'standard-deviation', source: 's' } }),
      cp('e', -0.25, { referenceUncertainty: { valueMetres: 0.03, meaning: 'standard-deviation', source: 's' } }),
    ];
    const r = checkpointAccuracy(mixed, { minSample: 5, uncertaintyCombination: quadratureSum });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    expect(r.pooled.referenceUncertaintyState).toBe('not-established');
    expect(r.pooled.referenceRmse).toBeNull();
    expect(r.pooled.combinedRmse).toBeNull();
  });

  it('a legacy bare-number descriptor defaults to unknown and never fabricates a sigma', () => {
    const r = checkpointAccuracy(
      RESIDUALS.map(([id, resid]) => cp(id, resid, { referenceUncertainty: referenceUncertaintyFromValue(0.05) })),
      { minSample: 5, uncertaintyCombination: quadratureSum },
    );
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    expect(r.pooled.referenceUncertaintyState).toBe('not-established');
    expect(r.pooled.referenceRmse).toBeNull();
    expect(r.pooled.combinedRmse).toBeNull();
    expect(r.pooled.rmse).toBeCloseTo(OBSERVED_RMSE, 12);
  });

  it('the legacy referenceSigma field still works as a stated 1-sigma', () => {
    const r = checkpointAccuracy(
      RESIDUALS.map(([id, resid]) => cp(id, resid, { referenceSigma: 0.03 })),
      { minSample: 5, uncertaintyCombination: quadratureSum },
    );
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    expect(r.pooled.referenceUncertaintyState).toBe('established');
    expect(r.pooled.referenceRmse).toBeCloseTo(0.03, 12);
    expect(r.pooled.combinedRmse).toBeCloseTo(Math.sqrt(OBSERVED_RMSE ** 2 + 0.03 ** 2), 12);
  });
});
