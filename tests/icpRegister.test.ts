import { describe, test, expect } from 'vitest';
import { icpRegister, applyIcp, type Vec3 } from '../src/terrain/change/icpRegister';

/** Deterministic pseudo-random cloud (seeded LCG) in a `size`-unit box. */
function cloud(n: number, size: number, seed: number): Vec3[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    pts.push([rnd() * size, rnd() * size, rnd() * size * 0.25]);
  }
  return pts;
}

/** Apply R(yaw)·p + t to make a target from a source. */
function transform(src: readonly Vec3[], yaw: number, t: Vec3): Vec3[] {
  return src.map((p) => applyIcp({ yawRad: yaw, translation: t }, p));
}

function maxError(a: readonly Vec3[], b: readonly Vec3[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const dx = a[i][0] - b[i][0], dy = a[i][1] - b[i][1], dz = a[i][2] - b[i][2];
    m = Math.max(m, Math.hypot(dx, dy, dz));
  }
  return m;
}

describe('icpRegister', () => {
  test('identical clouds → identity transform, ~0 residual', () => {
    const src = cloud(50, 40, 1);
    const r = icpRegister(src, src);
    expect(r.degenerate).toBe(false);
    expect(r.converged).toBe(true);
    expect(r.rmsResidual).toBeLessThan(1e-6);
    expect(Math.abs(r.yawRad)).toBeLessThan(1e-6);
    expect(Math.hypot(...r.translation)).toBeLessThan(1e-6);
  });

  test('recovers a known pure translation', () => {
    const src = cloud(60, 40, 7);
    const t: Vec3 = [5, -3, 2];
    const tgt = transform(src, 0, t);
    const r = icpRegister(src, tgt);
    expect(r.rmsResidual).toBeLessThan(0.01);
    expect(r.translation[0]).toBeCloseTo(5, 1);
    expect(r.translation[1]).toBeCloseTo(-3, 1);
    expect(r.translation[2]).toBeCloseTo(2, 1);
    // The solved transform reproduces the target.
    expect(maxError(src.map((p) => applyIcp(r, p)), tgt)).toBeLessThan(0.02);
  });

  test('inlier fraction: 1.0 for a clean overlap within tolerance', () => {
    const src = cloud(50, 40, 1);
    const r = icpRegister(src, src, { maxResidual: 0.001 });
    expect(r.inlierFraction).toBe(1);
  });

  test('inlier fraction: below 1 when residual exceeds tolerance', () => {
    const src = cloud(60, 40, 9);
    // Pitch about X — planar (yaw-only) ICP cannot remove it, so residual stays.
    const c = Math.cos(0.3), s = Math.sin(0.3);
    const tgt: Vec3[] = src.map(([x, y, z]) => [x, y * c - z * s, y * s + z * c]);
    const r = icpRegister(src, tgt, { maxResidual: 0.01 });
    expect(r.inlierFraction).toBeLessThan(1);
    expect(r.inlierFraction).toBeGreaterThanOrEqual(0);
  });

  test('recovers a known translation + yaw', () => {
    const src = cloud(60, 40, 11);
    const yaw0 = 0.08;
    const t: Vec3 = [4, -2, 1.5];
    const tgt = transform(src, yaw0, t);
    const r = icpRegister(src, tgt, { maxIterations: 60, tolerance: 1e-8 });
    expect(r.refused).toBe(false);
    expect(r.yawRad).toBeCloseTo(yaw0, 2);
    expect(r.rmsResidual).toBeLessThan(0.05);
    expect(maxError(src.map((p) => applyIcp(r, p)), tgt)).toBeLessThan(0.1);
  });

  test('refuses when two clouds cannot be aligned (residual exceeds the floor)', () => {
    const a = cloud(50, 40, 3);
    const b = cloud(50, 40, 999); // unrelated
    const r = icpRegister(a, b, { maxResidual: 1.0 });
    expect(r.rmsResidual).toBeGreaterThan(1.0);
    expect(r.refused).toBe(true);
  });

  test('degenerate input (fewer than 3 points) is refused, not thrown', () => {
    const r = icpRegister([[0, 0, 0]], cloud(10, 10, 1));
    expect(r.degenerate).toBe(true);
    expect(r.refused).toBe(true);
    expect(r.iterations).toBe(0);
  });

  test('a residual below the floor is accepted (not refused)', () => {
    const src = cloud(40, 30, 5);
    const tgt = transform(src, 0.03, [1, 1, 0.5]);
    const r = icpRegister(src, tgt, { maxResidual: 0.5 });
    expect(r.refused).toBe(false);
    expect(r.rmsResidual).toBeLessThan(0.5);
  });
});

describe('icpRegister — robust trimming (trimmed ICP with a median warm start)', () => {
  const SIZE = 40;
  const YAW0 = 0.06;
  const T0: Vec3 = [6, -4, 2];

  /** Max residual of the solved transform over the INLIER points only. */
  function inlierMaxError(
    r: Parameters<typeof applyIcp>[0],
    inliers: readonly Vec3[],
    tgt: readonly Vec3[],
  ): number {
    return maxError(inliers.map((p) => applyIcp(r, p)), tgt.slice(0, inliers.length));
  }

  /**
   * A partial-overlap pair. The inliers are a clean transformed copy of a base
   * cloud (perfect correspondence). The source ALSO carries a minority outlier
   * set that has NO counterpart in the target, produced by `outliers(seed)`.
   * `target` holds only the transformed inliers, so every outlier is a genuine
   * non-overlap point the fit must reject.
   */
  function overlapPair(
    nIn: number,
    seed: number,
    outliers: (seed: number) => Vec3[],
  ): { source: Vec3[]; target: Vec3[]; inliers: Vec3[] } {
    const base = cloud(nIn, SIZE, seed);
    const target = transform(base, YAW0, T0);
    return { source: [...base, ...outliers(seed ^ 0x9e3779b9)], target, inliers: base };
  }

  /** Gross far blunders: a compact cluster ~150 units off — the case that wrecks
   * a raw-centroid warm start (0.24·150 ≈ 36 units of pull) but leaves the
   * outlier-resistant median untouched. Think distant structure / points-at-
   * infinity / a stray second scan region. */
  const farBlunders = (n: number) => (seed: number): Vec3[] =>
    cloud(n, SIZE * 0.5, seed).map(([x, y, z]): Vec3 => [x + 150, y + 150, z + 150]);

  /** Scattered outliers spread symmetrically over ~3× the cloud extent —
   * vegetation, moving objects, mixed noise. No net centroid pull, but their
   * spurious correspondences still poison a plain least-squares. */
  const scattered = (n: number) => (seed: number): Vec3[] => {
    let s = seed >>> 0;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
    const out: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      out.push([(rnd() - 0.5) * SIZE * 3 + SIZE / 2, (rnd() - 0.5) * SIZE * 3 + SIZE / 2, (rnd() - 0.5) * SIZE]);
    }
    return out;
  };

  test('gross far blunders: trimming recovers the exact transform where the untrimmed centroid solve collapses', () => {
    // 80 inliers + 25 blunders (24%). This is the reverted failure mode: the
    // outliers destroy the centroid warm start.
    const { source, target, inliers } = overlapPair(80, 11, farBlunders(25));
    const keep = 80 / 105 - 0.02; // ≈ 0.74 — reject the blunders

    const untrimmed = icpRegister(source, target, { maxIterations: 60, tolerance: 1e-8 });
    const trimmed = icpRegister(source, target, { maxIterations: 60, tolerance: 1e-8, trimFraction: keep });

    const errUntrimmed = inlierMaxError(untrimmed, inliers, target);
    const errTrimmed = inlierMaxError(trimmed, inliers, target);

    // Centroid warm start dragged ~36 units off → the untrimmed fit is nowhere.
    expect(errUntrimmed).toBeGreaterThan(10);
    // Median warm start + trim locks straight onto the real surface.
    expect(errTrimmed).toBeLessThan(0.05);
    expect(errTrimmed).toBeLessThan(errUntrimmed * 0.01);
    // And it is the KNOWN transform, not merely some low-residual fit.
    expect(trimmed.yawRad).toBeCloseTo(YAW0, 3);
    expect(trimmed.translation[0]).toBeCloseTo(T0[0], 2);
    expect(trimmed.translation[1]).toBeCloseTo(T0[1], 2);
    expect(trimmed.translation[2]).toBeCloseTo(T0[2], 2);
  });

  test('scattered outliers (vegetation / moving objects): trimming beats the untrimmed solve', () => {
    const { source, target, inliers } = overlapPair(80, 11, scattered(25));
    const untrimmed = icpRegister(source, target, { maxIterations: 80, tolerance: 1e-8 });
    const trimmed = icpRegister(source, target, { maxIterations: 80, tolerance: 1e-8, trimFraction: 0.72 });

    const errUntrimmed = inlierMaxError(untrimmed, inliers, target);
    const errTrimmed = inlierMaxError(trimmed, inliers, target);

    expect(errUntrimmed).toBeGreaterThan(1.0); // outlier correspondences pull it off
    expect(errTrimmed).toBeLessThan(0.1); // trim rejects them
    expect(errTrimmed).toBeLessThan(errUntrimmed * 0.3); // strictly, clearly better
    expect(trimmed.yawRad).toBeCloseTo(YAW0, 2);
  });

  test('does NOT collapse: the trimmed fit stays finite, sane and near truth (the prior-revert failure mode)', () => {
    const { source, target, inliers } = overlapPair(90, 23, farBlunders(30));
    const r = icpRegister(source, target, { maxIterations: 60, tolerance: 1e-8, trimFraction: 0.72 });

    // Collapse would surface as a NaN/huge transform, a wild rotation, or a
    // residual blown up by a trim that kept the outliers. None of that here.
    expect(Number.isFinite(r.yawRad)).toBe(true);
    expect(r.translation.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.abs(r.yawRad)).toBeLessThan(Math.PI / 4);
    expect(inlierMaxError(r, inliers, target)).toBeLessThan(0.1);
  });

  test('diagnostics are honest: inlierFraction discloses the rejected outliers; rmsResidual is the inlier fit', () => {
    const nIn = 80, nOut = 25;
    const { source, target } = overlapPair(nIn, 11, farBlunders(nOut));
    const r = icpRegister(source, target, {
      maxIterations: 60, tolerance: 1e-8, trimFraction: 80 / 105 - 0.02, maxResidual: 0.25,
    });
    const inlierRatio = nIn / (nIn + nOut); // ≈ 0.762

    // inlierFraction is measured over the WHOLE cloud, so it must reveal that
    // ~24% did not register — it does not get to hide behind the trim.
    expect(r.inlierFraction).toBeGreaterThan(0.7);
    expect(r.inlierFraction).toBeLessThanOrEqual(inlierRatio + 1e-9);
    // rmsResidual reports the tight INLIER fit (the kept set), not an average
    // diluted by the far outliers, so a genuine registration is not falsely
    // refused by the maxResidual gate.
    expect(r.rmsResidual).toBeLessThan(0.25);
    expect(r.refused).toBe(false);
    expect(r.trimFraction).toBeCloseTo(80 / 105 - 0.02, 6);
  });

  test('no-outlier regression: trimming a clean pair recovers the transform as well as the untrimmed solve', () => {
    const base = cloud(60, SIZE, 11);
    const tgt = transform(base, YAW0, T0);

    const untrimmed = icpRegister(base, tgt, { maxIterations: 60, tolerance: 1e-8 });
    const trimmed = icpRegister(base, tgt, { maxIterations: 60, tolerance: 1e-8, trimFraction: 0.8 });

    expect(trimmed.refused).toBe(false);
    expect(trimmed.yawRad).toBeCloseTo(YAW0, 2);
    expect(inlierMaxError(trimmed, base, tgt)).toBeLessThan(0.1);
    // Trimming clean data must not make the fit meaningfully worse.
    expect(inlierMaxError(trimmed, base, tgt)).toBeLessThan(
      inlierMaxError(untrimmed, base, tgt) + 0.05,
    );
  });

  test('trimFraction is clamped to [0.05, 1] and echoed; the default (unset) leaves the solve untrimmed', () => {
    const src = cloud(50, SIZE, 1);
    expect(icpRegister(src, src, { trimFraction: 5 }).trimFraction).toBe(1);
    expect(icpRegister(src, src, { trimFraction: 0 }).trimFraction).toBe(0.05);
    expect(icpRegister(src, src).trimFraction).toBe(1); // unset → no trimming
  });
});
