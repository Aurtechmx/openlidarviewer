/**
 * spatialBlockHoldout.ts
 *
 * A more honest accuracy estimator than random point hold-out. The existing
 * `holdoutValidateDtm` withholds individual ground returns at random, but a
 * randomly withheld point is surrounded by training points from the same cell,
 * so the surface predicts it almost for free. The reported RMSE is optimistic
 * relative to how the DTM performs over a region with no nearby ground truth
 * (a real gap, a void, an unscanned strip).
 *
 * Spatial-block cross-validation removes that leakage: it partitions the extent
 * into blocks, withholds WHOLE blocks, and scores the held-out block from a
 * surface trained only on the other blocks. The model must then predict across
 * a gap the size of a block, which is the case a user actually cares about.
 * Spatially-structured error makes the blocked RMSE larger than the random one;
 * the gap between them is the optimism the random estimate hides.
 *
 * The surface model is INJECTED (`SurfaceModel`) so this core stays pure and
 * unit-testable with a trivial predictor. The real caller passes a DTM
 * fit/predict built on the same raster pipeline the live analyser uses; that
 * wiring is a separate, device-verified step.
 *
 * Determinism: fold assignment and the bootstrap both use a seeded mulberry32
 * PRNG, so the same points + seed give the same result.
 *
 * Pure data: no DOM, no three.js, no I/O.
 */

export interface XYZ {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A surface the estimator can fit to training points and query at a location.
 * `predict` returns null where the fitted surface has no coverage, so the
 * held-out point is counted as uncovered rather than scored against a guess.
 */
export interface SurfaceModel {
  fit(train: readonly XYZ[]): void;
  predict(x: number, y: number): number | null;
}

export interface SpatialBlockOptions {
  /** Block edge length, in the same units as x/y. Must be > 0. */
  readonly blockSize: number;
  /**
   * Number of spatial folds. Blocks are partitioned into this many groups; each
   * group is held out once. Default 5, capped at the number of non-empty blocks
   * (so tiny scenes fall back to leave-one-block-out).
   */
  readonly folds?: number;
  /** PRNG seed for fold assignment and the bootstrap. Default 1. */
  readonly seed?: number;
  /** Bootstrap resamples for the RMSE confidence interval. Default 1000. */
  readonly bootstrapN?: number;
  /** Confidence level for the interval, 0..1. Default 0.95. */
  readonly ciLevel?: number;
}

export interface SpatialBlockResult {
  readonly method: 'spatial-block-cv';
  /** RMSE over all held-out points, in the z unit. NaN when nothing scored. */
  readonly rmse: number;
  /** Mean absolute error over held-out points. */
  readonly mae: number;
  /** Held-out points that landed on covered surface and were scored. */
  readonly n: number;
  /** Held-out points with no covered prediction (skipped). */
  readonly uncovered: number;
  /** Non-empty spatial blocks. */
  readonly blocks: number;
  /** Folds actually run. */
  readonly folds: number;
  /** Lower bound of the bootstrap CI on RMSE. */
  readonly ciLow: number;
  /** Upper bound of the bootstrap CI on RMSE. */
  readonly ciHigh: number;
  /** The CI level used (echoed for the report). */
  readonly ciLevel: number;
  readonly warnings: readonly string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rmseOf(residuals: readonly number[]): number {
  if (residuals.length === 0) return Number.NaN;
  let s = 0;
  for (const r of residuals) s += r * r;
  return Math.sqrt(s / residuals.length);
}

/** Percentile of a pre-sorted array by linear interpolation (type-7). */
function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Run spatial-block cross-validation and return the blocked RMSE with a
 * bootstrap confidence interval. Honest on degenerate input: fewer than two
 * non-empty blocks cannot be split spatially, so it returns NaN with a warning
 * rather than a leaky single-block estimate.
 */
export function spatialBlockHoldout(
  points: readonly XYZ[],
  model: SurfaceModel,
  opts: SpatialBlockOptions,
): SpatialBlockResult {
  const warnings: string[] = [];
  const blockSize = opts.blockSize > 0 ? opts.blockSize : 1;
  if (!(opts.blockSize > 0)) warnings.push(`blockSize invalid; using ${blockSize}`);

  const finite = points.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
  );
  if (finite.length < 4) {
    return degenerate('too few finite points to cross-validate', opts, warnings);
  }

  // Assign each point to a block key.
  const blockOf = new Map<string, XYZ[]>();
  for (const p of finite) {
    const bx = Math.floor(p.x / blockSize);
    const by = Math.floor(p.y / blockSize);
    const key = `${bx}:${by}`;
    const bucket = blockOf.get(key);
    if (bucket) bucket.push(p);
    else blockOf.set(key, [p]);
  }
  const blockKeys = [...blockOf.keys()];
  if (blockKeys.length < 2) {
    return degenerate('all points fall in one block; cannot split spatially', opts, warnings);
  }

  // Deterministically shuffle blocks, then round-robin them into folds so each
  // fold holds out a spatially disjoint set of blocks.
  const rng = mulberry32(opts.seed ?? 1);
  const shuffled = [...blockKeys];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const folds = Math.max(2, Math.min(opts.folds ?? 5, blockKeys.length));
  const foldOfBlock = new Map<string, number>();
  shuffled.forEach((key, i) => foldOfBlock.set(key, i % folds));

  // For each fold: train on every OTHER block, score this fold's blocks.
  const residuals: number[] = [];
  let uncovered = 0;
  for (let f = 0; f < folds; f++) {
    const train: XYZ[] = [];
    const testBlocks: XYZ[] = [];
    for (const key of blockKeys) {
      const pts = blockOf.get(key) as XYZ[];
      if (foldOfBlock.get(key) === f) testBlocks.push(...pts);
      else train.push(...pts);
    }
    if (train.length === 0 || testBlocks.length === 0) continue;
    model.fit(train);
    for (const p of testBlocks) {
      const pred = model.predict(p.x, p.y);
      if (pred === null || !Number.isFinite(pred)) {
        uncovered++;
        continue;
      }
      residuals.push(p.z - pred);
    }
  }

  if (residuals.length === 0) {
    return degenerate('no held-out points landed on covered surface', opts, warnings, uncovered);
  }

  const rmse = rmseOf(residuals);
  let sumAbs = 0;
  for (const r of residuals) sumAbs += Math.abs(r);
  const mae = sumAbs / residuals.length;

  // Bootstrap CI on the RMSE: resample residuals with replacement, recompute.
  const B = Math.max(0, Math.floor(opts.bootstrapN ?? 1000));
  const ciLevel = opts.ciLevel ?? 0.95;
  let ciLow = rmse;
  let ciHigh = rmse;
  if (B > 0 && residuals.length > 1) {
    const boot = new Array<number>(B);
    const m = residuals.length;
    for (let b = 0; b < B; b++) {
      let s = 0;
      for (let k = 0; k < m; k++) {
        const r = residuals[Math.floor(rng() * m)];
        s += r * r;
      }
      boot[b] = Math.sqrt(s / m);
    }
    boot.sort((a, b) => a - b);
    const alpha = (1 - ciLevel) / 2;
    ciLow = percentileSorted(boot, alpha);
    ciHigh = percentileSorted(boot, 1 - alpha);
  }

  return {
    method: 'spatial-block-cv',
    rmse,
    mae,
    n: residuals.length,
    uncovered,
    blocks: blockKeys.length,
    folds,
    ciLow,
    ciHigh,
    ciLevel,
    warnings,
  };
}

function degenerate(
  reason: string,
  opts: SpatialBlockOptions,
  warnings: string[],
  uncovered = 0,
): SpatialBlockResult {
  return {
    method: 'spatial-block-cv',
    rmse: Number.NaN,
    mae: Number.NaN,
    n: 0,
    uncovered,
    blocks: 0,
    folds: 0,
    ciLow: Number.NaN,
    ciHigh: Number.NaN,
    ciLevel: opts.ciLevel ?? 0.95,
    warnings: [...warnings, reason],
  };
}
