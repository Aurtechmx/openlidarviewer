/**
 * spatialBlockHoldout.test.ts
 *
 * Confirms the spatial-block estimator's mechanics (CI brackets the point
 * estimate, determinism, degenerate handling) and its scientific point: on a
 * spatially-structured surface with a LOCAL predictor, blocked hold-out reports
 * a larger, more honest error than a scattered random hold-out. The gap is the
 * optimism the random estimate hides.
 */

import { describe, it, expect } from 'vitest';
import {
  spatialBlockHoldout, type XYZ, type SurfaceModel,
} from '../src/terrain/validate/spatialBlockHoldout';

/** A tilted plane: z = 0.5x + 0.2y over a dense square grid. */
function planeGrid(n = 20): XYZ[] {
  const pts: XYZ[] = [];
  for (let ix = 0; ix < n; ix++) {
    for (let iy = 0; iy < n; iy++) {
      pts.push({ x: ix, y: iy, z: 0.5 * ix + 0.2 * iy });
    }
  }
  return pts;
}

/** Predicts z of the nearest training point — a local model, so removing a
 *  whole block forces it to reach across the gap. */
class NearestModel implements SurfaceModel {
  private train: readonly XYZ[] = [];
  fit(train: readonly XYZ[]): void { this.train = train; }
  predict(x: number, y: number): number | null {
    let best = Infinity;
    let bz: number | null = null;
    for (const p of this.train) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < best) { best = d; bz = p.z; }
    }
    return bz;
  }
}

/** A scattered random hold-out (every 5th point) scored with the same nearest
 *  model — the optimistic baseline the blocked estimate should exceed. */
function randomHoldoutRmse(points: readonly XYZ[]): number {
  const train: XYZ[] = [];
  const test: XYZ[] = [];
  points.forEach((p, i) => (i % 5 === 0 ? test : train).push(p));
  const m = new NearestModel();
  m.fit(train);
  let sumSq = 0;
  let k = 0;
  for (const p of test) {
    const pred = m.predict(p.x, p.y);
    if (pred === null) continue;
    sumSq += (p.z - pred) ** 2;
    k++;
  }
  return Math.sqrt(sumSq / k);
}

describe('spatial-block hold-out', () => {
  it('returns a blocked RMSE with a bootstrap CI that brackets it', () => {
    const r = spatialBlockHoldout(planeGrid(), new NearestModel(), {
      blockSize: 5, seed: 7, bootstrapN: 500,
    });
    expect(r.method).toBe('spatial-block-cv');
    expect(r.blocks).toBe(16); // 20/5 = 4 blocks per axis
    expect(r.folds).toBeGreaterThanOrEqual(2);
    expect(r.n).toBeGreaterThan(0);
    expect(Number.isFinite(r.rmse)).toBe(true);
    expect(r.ciLow).toBeLessThanOrEqual(r.rmse);
    expect(r.ciHigh).toBeGreaterThanOrEqual(r.rmse);
    expect(r.ciLevel).toBe(0.95);
  });

  it('is deterministic for a given seed', () => {
    const a = spatialBlockHoldout(planeGrid(), new NearestModel(), { blockSize: 5, seed: 42 });
    const b = spatialBlockHoldout(planeGrid(), new NearestModel(), { blockSize: 5, seed: 42 });
    expect(b.rmse).toBe(a.rmse);
    expect(b.ciLow).toBe(a.ciLow);
    expect(b.ciHigh).toBe(a.ciHigh);
  });

  it('reports MORE error than a scattered random hold-out (exposes optimism)', () => {
    const pts = planeGrid();
    const blocked = spatialBlockHoldout(pts, new NearestModel(), { blockSize: 5, seed: 3 });
    const random = randomHoldoutRmse(pts);
    // The scattered hold-out predicts each point from an adjacent neighbour, so
    // it barely errs; the blocked hold-out must cross a 5-unit gap. Blocked must
    // be the larger, more honest number.
    expect(blocked.rmse).toBeGreaterThan(random);
  });

  it('is translation-invariant: shifting all coordinates gives the same RMSE', () => {
    const shift = (pts: XYZ[], d: number): XYZ[] => pts.map((p) => ({ x: p.x + d, y: p.y + d, z: p.z }));
    const base = planeGrid();
    const a = spatialBlockHoldout(base, new NearestModel(), { blockSize: 5, seed: 3 });
    const b = spatialBlockHoldout(shift(base, 1000), new NearestModel(), { blockSize: 5, seed: 3 });
    // Blocks anchor at the data minimum, so a global translation must not change
    // the partition, the folds, or the reported error.
    expect(b.rmse).toBeCloseTo(a.rmse, 9);
    expect(b.blocks).toBe(a.blocks);
  });

  it('refuses to split when everything is in one block', () => {
    const clustered: XYZ[] = [
      { x: 0.1, y: 0.1, z: 1 }, { x: 0.2, y: 0.2, z: 1 },
      { x: 0.3, y: 0.1, z: 1 }, { x: 0.15, y: 0.25, z: 1 },
    ];
    const r = spatialBlockHoldout(clustered, new NearestModel(), { blockSize: 100 });
    expect(Number.isNaN(r.rmse)).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/one block/i);
  });

  it('is honest on too few points', () => {
    const r = spatialBlockHoldout([{ x: 0, y: 0, z: 0 }], new NearestModel(), { blockSize: 1 });
    expect(Number.isNaN(r.rmse)).toBe(true);
    expect(r.n).toBe(0);
  });
});

// ── Invalid specifications are refused, not repaired ────────────────────────
// blockSize 0 became 1 with a warning, a NaN fold count propagated through
// Math.min/Math.max, bootstrapN was floored and ciLevel was accepted at any
// value. Each produced a valid-looking RMSE and confidence interval from an
// invalid specification, and a warning string beside a number is not a refusal:
// the caller still gets a statistic it can quote.
describe('spatialBlockHoldout refuses an invalid specification', () => {
  const run = (opts: Record<string, unknown>) =>
    () => spatialBlockHoldout(planeGrid(), new NearestModel(),
      { blockSize: 5, ...opts } as never);

  it('refuses a non-positive or non-finite block size', () => {
    for (const blockSize of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(run({ blockSize }), `blockSize ${blockSize}`).toThrow(/blockSize must be/);
    }
  });

  it('refuses a fold count that is not an integer of at least 2', () => {
    for (const folds of [1, 0, -3, 2.5, Number.NaN]) {
      expect(run({ folds }), `folds ${folds}`).toThrow(/folds must be/);
    }
  });

  it('refuses a seed that is not a non-negative integer', () => {
    for (const seed of [-1, 1.5, Number.NaN]) {
      expect(run({ seed }), `seed ${seed}`).toThrow(/seed must be/);
    }
  });

  it('refuses a bootstrap count that is not a non-negative integer', () => {
    for (const bootstrapN of [-1, 10.5, Number.NaN]) {
      expect(run({ bootstrapN }), `bootstrapN ${bootstrapN}`).toThrow(/bootstrapN must be/);
    }
  });

  it('refuses a confidence level outside (0, 1)', () => {
    // 0 and 1 are excluded: an interval of zero width and one of infinite
    // width are both specifications nobody means.
    for (const ciLevel of [0, 1, -0.5, 1.5, Number.NaN]) {
      expect(run({ ciLevel }), `ciLevel ${ciLevel}`).toThrow(/ciLevel must/);
    }
  });

  it('accepts a valid specification, so the guard is not blanket', () => {
    expect(run({ folds: 3, seed: 7, bootstrapN: 50, ciLevel: 0.9 })).not.toThrow();
  });
});
