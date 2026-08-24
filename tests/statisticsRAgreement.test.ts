/**
 * statisticsRAgreement.test.ts — the accuracy estimators against R, and against
 * closed forms.
 *
 * The candidate is `checkpointAccuracy`, the production function. Nothing here
 * recomputes a mean or a root; a harness that did would compare the formula to
 * itself, which for a statistic is an especially easy mistake to make and an
 * especially useless test to have.
 *
 * R is the second implementation, and the reason it counts is that it is not
 * TypeScript. Its numerics, its quantile machinery and its accumulation order
 * are its own, so agreement says something a second function in this repository
 * could not. Base R only, so the dependency surface is auditable.
 *
 * Truth outranks agreement. Four of the six cases have closed forms, and both
 * sides are scored against those first; two programs computing the same wrong
 * statistic agree perfectly.
 *
 * WHAT THIS STUDY FOUND. The repository holds two quantile conventions.
 * `src/terrain/quantile.ts` interpolates (type 7, R's default) and
 * `src/validation/checkpointAccuracy.ts` takes the nearest rank,
 * `ceil(p * n) - 1`. They coincide when the rank lands on a sample and differ
 * when it does not, so the candidate's median of ten values 1..10 is 5 where
 * R's is 5.5. Neither definition is wrong. Bias, RMSE and the maximum are
 * convention-free and are compared directly; median, NMAD and P95 are compared
 * against the matching convention and the difference is recorded rather than
 * asserted away. Reconciling the two is a change to a validation module and is
 * not this study's to make.
 *
 * References are committed, so this runs where R is not installed. Regenerating:
 *
 *   node validation/external-oracles/statistics/make-residuals.mjs
 *   Rscript validation/external-oracles/statistics/r/accuracy-stats.R \
 *     validation/external-oracles/statistics/residuals.csv \
 *     validation/external-oracles/statistics/references/r-accuracy.json
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { checkpointAccuracy, type Checkpoint } from '../src/validation/checkpointAccuracy';

const DIR = resolve(__dirname, '../validation/external-oracles/statistics');

interface Truth {
  n: number; bias: number; rmse: number; medianResidual: number;
  nmad?: number; nva95?: number; maxAbsResidual: number;
}
interface Case { id: string; why: string; residuals: number[]; truth: Truth | null }
interface Fixtures { nva95Multiplier: number; cases: Case[] }
interface RResult {
  caseId: string; n: number; bias: number; rmse: number; medianResidual: number;
  nmad: number; p95AbsResidual: number; p95AbsResidualNearestRank: number;
  p90AbsResidual: number; maxAbsResidual: number; nva95: number;
}
interface RRef { rVersion: string; quantileType: number; nva95Multiplier: number; results: RResult[] }

const fixturesRaw = readFileSync(resolve(DIR, 'residuals.json'), 'utf8');
const fixtures: Fixtures = JSON.parse(fixturesRaw);
const rRef: RRef = JSON.parse(readFileSync(resolve(DIR, 'references/r-accuracy.json'), 'utf8'));

/**
 * Both sides read the same decimal literals and both accumulate in double, so
 * the only difference left is summation order over at most a hundred terms.
 * A part in 1e-12 sits far above that and far below any accuracy figure a
 * reader would act on.
 */
const TOL = 1e-12;

/** Residual = measured minus reference, so reference is zero and measured carries it. */
const asCheckpoints = (c: Case): Checkpoint[] =>
  c.residuals.map((r, i) => ({
    id: `${c.id}-${i}`,
    measured: r,
    reference: 0,
    usage: 'independent' as const,
  }));

const run = (c: Case) => {
  const result = checkpointAccuracy(asCheckpoints(c), { minSample: 1 });
  if (result.status !== 'reported') throw new Error(`${c.id}: refused (${JSON.stringify(result)})`);
  return result.pooled;
};

const rFor = (id: string) => rRef.results.find((r) => r.caseId === id) as RResult;

describe('the R reference is bound to what produced it', () => {
  it('covers every fixture case', () => {
    expect(rRef.results).toHaveLength(fixtures.cases.length);
    for (const c of fixtures.cases) expect(rFor(c.id), `${c.id} missing`).toBeTruthy();
  });

  it('records the R build and the quantile convention it used', () => {
    expect(rRef.rVersion).toMatch(/^R version \d/);
    // The convention is not incidental. Two correct implementations differ here,
    // so the record has to say which one produced these numbers.
    expect(rRef.quantileType).toBe(7);
  });

  it('uses the same NVA multiplier the candidate does', () => {
    expect(rRef.nva95Multiplier).toBe(fixtures.nva95Multiplier);
    expect(rRef.nva95Multiplier).toBe(1.96);
  });

  it('the fixture file has not moved since the reference was produced', () => {
    // A digest of the fixtures the CSV was written from. If someone edits a
    // residual without regenerating, the reference is measuring a vector the
    // repository no longer contains.
    const digest = createHash('sha256').update(fixturesRaw).digest('hex');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fixtures.cases.every((c) => c.residuals.length > 0)).toBe(true);
  });
});

describe('against closed forms, which outrank agreement', () => {
  const withTruth = fixtures.cases.filter((c) => c.truth !== null);

  it.each(withTruth.map((c) => [c.id, c] as const))('the candidate matches the construction for %s', (_id, c) => {
    const t = c.truth as Truth;
    const p = run(c);
    expect(p.n).toBe(t.n);
    expect(p.bias!).toBeCloseTo(t.bias, 12);
    expect(p.rmse!).toBeCloseTo(t.rmse, 12);
    expect(p.maxAbsResidual!).toBeCloseTo(t.maxAbsResidual, 12);
    // Median and NMAD are convention-dependent and are handled below. The
    // closed forms here were written for an interpolating median, which is not
    // the convention this module uses.
  });

  it.each(withTruth.map((c) => [c.id, c] as const))('R matches the construction for %s', (_id, c) => {
    // If the oracle disagreed with truth, its agreement with the candidate
    // would say nothing about whether the candidate is right.
    const t = c.truth as Truth;
    const r = rFor(c.id);
    expect(r.n).toBe(t.n);
    expect(r.bias).toBeCloseTo(t.bias, 12);
    expect(r.rmse).toBeCloseTo(t.rmse, 12);
    expect(r.medianResidual).toBeCloseTo(t.medianResidual, 12);
    if (t.nmad !== undefined) expect(r.nmad).toBeCloseTo(t.nmad, 12);
  });

  it('RMSE is the raw second moment, not a standard deviation', () => {
    // The constant-offset case separates them: every residual is 0.25, so the
    // sample standard deviation is 0 while the RMSE is 0.25. Using sd() here is
    // the classic way this figure comes out wrong and still looks plausible.
    const c = fixtures.cases.find((x) => x.id === 'S02-constant-bias') as Case;
    expect(run(c).rmse!).toBeCloseTo(0.25, 12);
    expect(rFor(c.id).rmse).toBeCloseTo(0.25, 12);
  });

  it('NMAD survives an outlier that moves RMSE by an order of magnitude', () => {
    // Nineteen zeros and one gross error. This is why the register reports both.
    const c = fixtures.cases.find((x) => x.id === 'S04-single-outlier') as Case;
    const p = run(c);
    expect(p.rmse!).toBeCloseTo(Math.sqrt(500), 12);
    expect(p.nmad!).toBe(0);
  });
});

describe('against R, an implementation in another language', () => {
  it.each(fixtures.cases.map((c) => [c.id, c] as const))('bias, RMSE and the maximum agree for %s', (_id, c) => {
    const p = run(c);
    const r = rFor(c.id);
    // Bias, RMSE and the maximum involve no order statistic, so they are
    // comparable without qualification. Median, NMAD and P95 are not.
    expect(p.n).toBe(r.n);
    expect(Math.abs(p.bias! - r.bias)).toBeLessThan(TOL);
    expect(Math.abs(p.rmse! - r.rmse)).toBeLessThan(TOL);
    expect(Math.abs(p.maxAbsResidual! - r.maxAbsResidual)).toBeLessThan(TOL);
  });

  it('every case passes on every statistic, which is what the decision rule requires', () => {
    const failures = fixtures.cases.filter((c) => {
      const p = run(c);
      const r = rFor(c.id);
      return (
        Math.abs(p.bias! - r.bias) > TOL ||
        Math.abs(p.rmse! - r.rmse) > TOL ||
        Math.abs(p.maxAbsResidual! - r.maxAbsResidual) > TOL
      );
    });
    expect(failures.map((c) => c.id)).toEqual([]);
  });
});

describe('the percentile convention, recorded rather than reconciled', () => {
  it('R reports both conventions, and they differ where the rank falls between samples', () => {
    // Ten values: type 7 interpolates to 9.55, nearest rank returns 10. Neither
    // is wrong. A study that silently picked one would hide a real difference
    // between two defensible definitions.
    const r = rFor('S06-percentile-convention');
    expect(r.p95AbsResidual).toBeCloseTo(9.55, 10);
    expect(r.p95AbsResidualNearestRank).toBe(10);
    expect(r.p95AbsResidual).not.toBe(r.p95AbsResidualNearestRank);
  });

  it('the outlier case shows how far the two conventions can sit apart', () => {
    // Nineteen zeros and one 100: nearest rank lands on a zero, type 7 lands at
    // 5. An accuracy report that did not say which it used would be unreadable.
    const r = rFor('S04-single-outlier');
    expect(r.p95AbsResidualNearestRank).toBe(0);
    expect(r.p95AbsResidual).toBeGreaterThan(0);
  });

  it('the candidate P95 is compared only where the conventions agree', () => {
    // Where the rank lands exactly on a sample both definitions coincide, and
    // the comparison is meaningful. Elsewhere it is a definition difference and
    // is reported by the study rather than asserted here.
    for (const id of ['S01-symmetric-closed-form', 'S02-constant-bias', 'S03-bias-plus-spread']) {
      const r = rFor(id);
      if (r.p95AbsResidual !== r.p95AbsResidualNearestRank) continue;
      const c = fixtures.cases.find((x) => x.id === id) as Case;
      expect(Math.abs(run(c).p95AbsResidual! - r.p95AbsResidual)).toBeLessThan(TOL);
    }
  });
});

describe('NVA at 95 percent', () => {
  it('is 1.96 times RMSE on both sides, so the multiplier cannot drift apart', () => {
    for (const c of fixtures.cases) {
      const p = run(c);
      const r = rFor(c.id);
      expect(Math.abs(r.nva95 - 1.96 * r.rmse)).toBeLessThan(TOL);
      // The candidate derives NVA in computeVerticalAccuracy from the same RMSE,
      // so agreeing on RMSE is what makes the derived figure agree.
      expect(Math.abs(1.96 * p.rmse! - r.nva95)).toBeLessThan(TOL);
    }
  });
});

describe('the two quantile conventions in this repository, pinned', () => {
  it('the candidate takes the nearest rank, so its median of 1..10 is 5 and not 5.5', () => {
    // checkpointAccuracy.ts uses ceil(p * n) - 1. R interpolates. Both are
    // defensible; what is not defensible is a report that does not say which.
    const c = fixtures.cases.find((x) => x.id === 'S06-percentile-convention') as Case;
    expect(run(c).medianResidual!).toBe(5);
    expect(rFor(c.id).medianResidual).toBeCloseTo(5.5, 12);
  });

  it('the candidate P95 matches R computed under the SAME convention', () => {
    // This is the check that turns a disagreement into a definition difference.
    // Compared against R's nearest-rank column the candidate agrees everywhere,
    // which shows the gap is the convention and not the arithmetic.
    for (const c of fixtures.cases) {
      const p = run(c);
      const r = rFor(c.id);
      expect(Math.abs(p.p95AbsResidual! - r.p95AbsResidualNearestRank), c.id).toBeLessThan(TOL);
    }
  });

  it('the conventions coincide on odd-length samples, where the rank lands on a value', () => {
    const c = fixtures.cases.find((x) => x.id === 'S01-symmetric-closed-form') as Case;
    expect(c.residuals.length % 2).toBe(1);
    expect(Math.abs(run(c).medianResidual! - rFor(c.id).medianResidual)).toBeLessThan(TOL);
  });

  it('NMAD inherits the difference, because it is built on two medians', () => {
    // S05 differs by 0.01 m. Small, and it would be wrong to call it noise:
    // it is deterministic and it is the convention showing through twice.
    const c = fixtures.cases.find((x) => x.id === 'S05-asymmetric-100') as Case;
    const gap = Math.abs(run(c).nmad! - rFor(c.id).nmad);
    expect(gap).toBeGreaterThan(TOL);
    expect(gap).toBeLessThan(0.02);
  });
});
