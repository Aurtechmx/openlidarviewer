/**
 * checkpointAccuracy.test.ts
 *
 * Exercises the checkpoint statistics with SYNTHETIC checkpoints. It proves the
 * maths and the leakage refusal; it validates no product and supports no claim.
 *
 * The leakage refusal is the reason the module exists, so it is tested for every
 * disqualifying usage rather than one representative case.
 */

import { describe, it, expect } from 'vitest';
import {
  checkpointAccuracy,
  CI_ASSUMPTION,
  DEFAULT_CI_Z,
  LEAKING_USAGES,
  UNSTRATIFIED,
  type Checkpoint,
  type CheckpointUsage,
  type UncertaintyCombination,
} from '../src/validation/checkpointAccuracy';

/** Residual r means measured sits r above the surveyed reference. */
function cp(
  id: string,
  residual: number,
  extra: Partial<Checkpoint> = {},
): Checkpoint {
  return {
    id,
    reference: 100,
    measured: 100 + residual,
    usage: 'independent',
    ...extra,
  };
}

// Residuals 0.10, -0.05, 0.20, 0.00, -0.25: bias 0, rmse sqrt(0.023),
// median 0, |r| sorted [0, 0.05, 0.1, 0.2, 0.25], nmad 1.4826 x 0.1.
const FIVE = [
  cp('a', 0.1),
  cp('b', -0.05),
  cp('c', 0.2),
  cp('d', 0),
  cp('e', -0.25),
];

describe('checkpointAccuracy statistics', () => {
  it('reports hand-checked pooled statistics', () => {
    const r = checkpointAccuracy(FIVE, { minSample: 5 });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    const p = r.pooled;
    expect(p.n).toBe(5);
    expect(p.bias).toBeCloseTo(0, 12);
    expect(p.rmse).toBeCloseTo(Math.sqrt(0.115 / 5), 12);
    expect(p.medianResidual).toBeCloseTo(0, 12);
    expect(p.nmad).toBeCloseTo(1.4826 * 0.1, 12);
    expect(p.p90AbsResidual).toBeCloseTo(0.25, 12);
    expect(p.p95AbsResidual).toBeCloseTo(0.25, 12);
    expect(p.maxAbsResidual).toBeCloseTo(0.25, 12);
  });

  it('reports a confidence interval on the bias and names its assumption', () => {
    const r = checkpointAccuracy(FIVE, { minSample: 5 });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    const se = Math.sqrt(0.115 / 4) / Math.sqrt(5);
    expect(r.pooled.standardError).toBeCloseTo(se, 12);
    expect(r.pooled.biasCiLower).toBeCloseTo(-DEFAULT_CI_Z * se, 12);
    expect(r.pooled.biasCiUpper).toBeCloseTo(DEFAULT_CI_Z * se, 12);
    expect(r.ciZ).toBe(DEFAULT_CI_Z);
    expect(r.ciAssumption).toBe(CI_ASSUMPTION);
  });

  it('honours a caller-supplied interval multiplier', () => {
    const r = checkpointAccuracy(FIVE, { minSample: 5, ciZ: 1 });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    const se = r.pooled.standardError;
    expect(se).not.toBeNull();
    expect(r.pooled.biasCiUpper).toBeCloseTo((r.pooled.bias ?? 0) + (se ?? 0), 12);
  });

  it('leaves the interval null with a single checkpoint rather than zero-width', () => {
    const r = checkpointAccuracy([cp('only', 0.3)], { minSample: 1 });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    expect(r.pooled.n).toBe(1);
    expect(r.pooled.rmse).toBeCloseTo(0.3, 12);
    expect(r.pooled.standardError).toBeNull();
    expect(r.pooled.biasCiLower).toBeNull();
    expect(r.pooled.biasCiUpper).toBeNull();
  });

  it('exposes each residual so it can be traced back to a checkpoint', () => {
    const r = checkpointAccuracy(FIVE, { minSample: 5 });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    expect(r.residuals).toHaveLength(5);
    expect(r.residuals[0].id).toBe('a');
    expect(r.residuals[0].stratum).toBe(UNSTRATIFIED);
    expect(r.residuals[0].residual).toBeCloseTo(0.1, 12);
  });
});

describe('checkpointAccuracy stratification', () => {
  const mixed: Checkpoint[] = [
    cp('o1', 0.05, { stratum: 'open' }),
    cp('o2', -0.05, { stratum: 'open' }),
    cp('o3', 0.0, { stratum: 'open' }),
    cp('c1', 0.8, { stratum: 'canopy' }),
    cp('c2', 1.2, { stratum: 'canopy' }),
    cp('c3', 1.0, { stratum: 'canopy' }),
  ];

  it('reports every stratum as well as the pool', () => {
    const r = checkpointAccuracy(mixed, { minSample: 6, minStratumSample: 3 });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    expect(r.strata.map((s) => s.stratum)).toEqual(['canopy', 'open']);
    const canopy = r.strata[0];
    const open = r.strata[1];
    expect(canopy.status).toBe('reported');
    expect(open.status).toBe('reported');
    expect(canopy.stats.bias).toBeCloseTo(1, 12);
    expect(open.stats.bias).toBeCloseTo(0, 12);
    // The pooled bias describes neither stratum, which is why both are reported.
    expect(r.pooled.bias).toBeCloseTo(0.5, 12);
  });

  it('marks a thin stratum insufficient instead of dropping or reporting it', () => {
    const thin = [...mixed, cp('w1', 0.4, { stratum: 'water' })];
    const r = checkpointAccuracy(thin, { minSample: 6, minStratumSample: 3 });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    const water = r.strata.find((s) => s.stratum === 'water');
    expect(water).toBeDefined();
    expect(water?.status).toBe('insufficient');
    expect(water?.stats.n).toBe(1);
    expect(water?.stats.rmse).toBeNull();
    expect(water?.stats.bias).toBeNull();
  });
});

describe('checkpointAccuracy leakage refusal', () => {
  it('refuses every disqualifying usage', () => {
    for (const usage of LEAKING_USAGES) {
      const r = checkpointAccuracy([...FIVE, cp('leak', 0.01, { usage })], { minSample: 3 });
      expect(r.status).toBe('refused');
      if (r.status !== 'refused') continue;
      expect(r.reason).toBe('leakage');
      expect(r.offendingIds).toEqual(['leak']);
      expect(r.detail).toContain(usage);
    }
  });

  it('lists every leaking checkpoint, not just the first', () => {
    const r = checkpointAccuracy(
      [
        cp('x', 0.1, { usage: 'control' }),
        cp('y', 0.1),
        cp('z', 0.1, { usage: 'manual-correction' }),
      ],
      { minSample: 1 },
    );
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.offendingIds).toEqual(['x', 'z']);
  });

  it('refuses rather than silently filtering the leaked checkpoints out', () => {
    const clean = checkpointAccuracy(FIVE, { minSample: 5 });
    const dirty = checkpointAccuracy(
      [...FIVE, cp('control-point', 0, { usage: 'control' })],
      { minSample: 5 },
    );
    expect(clean.status).toBe('reported');
    // The five independent checkpoints would still clear minSample, so a
    // filtering implementation would have returned a number here.
    expect(dirty.status).toBe('refused');
  });

  it('accepts checkpoints explicitly marked independent', () => {
    const usage: CheckpointUsage = 'independent';
    const r = checkpointAccuracy([cp('i1', 0.1, { usage }), cp('i2', -0.1, { usage })], {
      minSample: 2,
    });
    expect(r.status).toBe('reported');
  });
});

describe('checkpointAccuracy sample-size and input refusals', () => {
  it('refuses a sample below the caller minimum as insufficient', () => {
    const r = checkpointAccuracy(FIVE.slice(0, 2), { minSample: 20 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('insufficient');
    expect(r.detail).toContain('20 required');
  });

  it('refuses a nonsensical minimum', () => {
    const r = checkpointAccuracy(FIVE, { minSample: 0 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('invalid-min-sample');
  });

  it('refuses a nonsensical interval multiplier', () => {
    const r = checkpointAccuracy(FIVE, { minSample: 1, ciZ: 0 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('invalid-ci-z');
  });

  it('refuses a repeated checkpoint id', () => {
    const r = checkpointAccuracy([cp('dup', 0.1), cp('dup', 0.2)], { minSample: 1 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('duplicate-id');
    expect(r.offendingIds).toEqual(['dup']);
  });

  it('refuses when no checkpoint carries usable numbers', () => {
    const r = checkpointAccuracy(
      [{ id: 'n1', measured: Number.NaN, reference: 100, usage: 'independent' }],
      { minSample: 1 },
    );
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('no-valid-residuals');
  });
});

describe('checkpointAccuracy reference uncertainty', () => {
  const withSigma = [
    cp('a', 0.1, { referenceSigma: 0.03 }),
    cp('b', -0.05, { referenceSigma: 0.03 }),
    cp('c', 0.2, { referenceSigma: 0.03 }),
    cp('d', 0, { referenceSigma: 0.03 }),
    cp('e', -0.25, { referenceSigma: 0.03 }),
  ];

  it('does not touch the reported error when no combination is supplied', () => {
    const r = checkpointAccuracy(withSigma, { minSample: 5 });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    expect(r.pooled.referenceRmse).toBeCloseTo(0.03, 12);
    // No default subtraction, and no relabelled RMSE.
    expect(r.pooled.combinedRmse).toBeNull();
    expect(r.pooled.uncertaintyCombinationId).toBeNull();
    expect(r.pooled.rmse).toBeCloseTo(Math.sqrt(0.115 / 5), 12);
  });

  it('applies exactly the combination the caller preregistered', () => {
    const quadratureSum: UncertaintyCombination = {
      id: 'test-quadrature-sum-v1',
      combine: (observed, reference) => Math.sqrt(observed * observed + reference * reference),
    };
    const r = checkpointAccuracy(withSigma, {
      minSample: 5,
      uncertaintyCombination: quadratureSum,
    });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    const observed = Math.sqrt(0.115 / 5);
    expect(r.pooled.combinedRmse).toBeCloseTo(
      Math.sqrt(observed * observed + 0.03 * 0.03),
      12,
    );
    expect(r.pooled.uncertaintyCombinationId).toBe('test-quadrature-sum-v1');
  });

  it('leaves the combined figure null when no reference sigma was stated', () => {
    const r = checkpointAccuracy(FIVE, {
      minSample: 5,
      uncertaintyCombination: { id: 'unused', combine: () => 0 },
    });
    expect(r.status).toBe('reported');
    if (r.status !== 'reported') return;
    expect(r.pooled.referenceRmse).toBeNull();
    expect(r.pooled.combinedRmse).toBeNull();
    expect(r.pooled.uncertaintyCombinationId).toBeNull();
  });
});
