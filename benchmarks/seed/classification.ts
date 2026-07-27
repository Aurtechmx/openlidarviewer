/**
 * classification.ts: which reported quantities must not move when the seed
 * changes, which are free to, and at what precision each one is published.
 *
 * WHY THIS FILE IS SEPARATE FROM THE SWEEP. Everything here is pre-registered:
 * the group each quantity belongs to, the tolerance for the invariant group,
 * the magnitude that tolerance is derived from, and the number of decimals the
 * project publishes each quantity with. Keeping it in its own module makes the
 * registration reviewable on its own and stops a tolerance from being nudged
 * next to the assertion that failed.
 *
 * THE DISTINCTION THIS SUITE RESTS ON. The reproducibility suite fixes seed
 * 20260726 and proves the pipeline is deterministic there. Determinism is a
 * statement about repeating one draw. It says nothing about what a different
 * draw from the same distribution would have produced, and a pipeline can be
 * bit-exact on replay while reporting a materially different answer for the
 * next sample. Two groups follow from that:
 *
 *   INVARIANT — fixed by the configuration or by the surface definition, not by
 *   which points were drawn from it. The DTM grid geometry follows from the
 *   tile extent and the cell size, both pinned. The fitted slope of a planar
 *   fixture follows from the plane, and the sample only adds noise that
 *   averages out. These are asserted, at a tolerance derived below.
 *
 *   VARIABLE — a property of the sample. The extreme elevations are order
 *   statistics of the draw. The surviving ground-return count is the ground
 *   filter's verdict on a particular set of returns. Contour counts follow the
 *   realised surface. A distribution is reported for these and NOTHING is
 *   asserted about them. An assertion over a random quantity either passes by
 *   construction or fails at a rate nobody chose; both are worse than a
 *   reported spread.
 *
 * NO IN-BETWEEN CATEGORY. `contourIntervalM` is the quantity that tempts one.
 * It is selected from the realised relief, so it is a function of the sample
 * and belongs in VARIABLE, even though every seed in the recorded sweep landed
 * on the same interval. Observing one distinct value over a finite sweep is not
 * invariance and is not recorded as such.
 */

/** A published quantity and everything pre-registered about it. */
export interface QuantitySpec {
  readonly name: string;
  readonly group: 'invariant' | 'variable';
  /** Physical unit, or `count` / `ratio` / `index` for dimensionless ones. */
  readonly unit: string;
  /**
   * Decimals the project publishes this quantity with, read off the format
   * calls in `benchmarks/runner/render.ts`. The reported quantum is 10^-d, and
   * a seed-to-seed spread larger than that quantum means the published figure
   * carries digits the measurement does not support.
   */
  readonly publishedDecimals: number;
  /**
   * Largest seed-to-seed range tolerated. Invariant group only; `null` for the
   * variable group, where no tolerance exists because nothing is asserted.
   */
  readonly toleranceRange: number | null;
  /** The magnitude the tolerance was derived from. Invariant group only. */
  readonly toleranceBasis: string | null;
  /** Why the quantity sits in the group it does. */
  readonly rationale: string;
}

/**
 * Points per fixture in the sweep.
 *
 * The tile extent is sqrt(pointCount / density) with density pinned at 4 pts/m²,
 * so 60,000 points gives a 122.474 m tile. On the 2 m grid that is 61.237 cells,
 * and `ceil` puts the column count at 62 with 0.474 m of margin to the nearest
 * cell boundary. The margin matters because the grid is sized from the extremes
 * of the drawn points rather than from the nominal extent: the smallest drawn
 * x sits about extent/N ≈ 2 mm from the tile edge, exponentially distributed,
 * so the chance a draw eats 0.474 m of margin and moves the column count is
 * exp(-0.474 * N / extent) ≈ e^-232. That is what makes the grid geometry
 * assertable at a tolerance of exactly zero rather than merely usually stable.
 *
 * A point count whose extent landed near a cell multiple would make the same
 * assertion fail intermittently, which is why the count is pinned here with the
 * margin computed rather than picked for round numbers.
 */
export const SWEEP_POINT_COUNT = 60_000;

/** Grid cell size, source units. Pinned; the pipeline default. */
export const SWEEP_CELL_SIZE_M = 2;

/**
 * Number of independently seeded fixtures.
 *
 * WHAT 32 RESOLVES. A coefficient of variation estimated from n samples of a
 * normal quantity has a relative standard error of about 1/sqrt(2(n-1)), which
 * at n = 32 is 0.127. So a CV reported here is good to roughly ±13 % of itself
 * at one standard error and ±25 % across a 95 % interval: a reported CV of
 * 0.010 is consistent with anything from about 0.0075 to 0.0125. That separates
 * a sub-percent CV from a several-percent one. It does not separate 0.010 from
 * 0.013, and no figure in this suite's output should be read as if it did.
 *
 * WHAT IT DOES NOT RESOLVE AT ALL. The tails. 32 draws put no useful bound on
 * how extreme a rare seed can be; the min and max columns are the two most
 * extreme of 32 draws and nothing more. A quantity that is well behaved over
 * this sweep may still have a seed that breaks it.
 *
 * WHY NOT MORE. Each fixture costs one full pipeline run, about 0.4 s at this
 * point count on the development machine, so 32 is around 13 s and the suite
 * stays in the always-on set. Raising n to 128 would tighten the CV interval by
 * a factor of two and cost four times as much; the interval is stated instead.
 */
export const SWEEP_SEED_COUNT = 32;

/**
 * Seeds are `SWEEP_SEED_BASE + i * SWEEP_SEED_STRIDE`, a prime stride so the draws
 * are spread across the seed space rather than taken consecutively.
 *
 * A LIMITATION, NAMED. The fixture PRNG is mulberry32, whose state update is an
 * addition; two seeds differing by a constant produce streams that differ by
 * that constant before the avalanche mixes them. The mixing is what makes the
 * streams look independent, and this suite does not test the mixing. What it
 * establishes is the spread over 32 distinct seeds of this generator, not the
 * spread over an ideal i.i.d. resampling of the distribution.
 */
export const SWEEP_SEED_BASE = 900_017;
export const SWEEP_SEED_STRIDE = 7_919;

export function sweepSeeds(count: number = SWEEP_SEED_COUNT): readonly number[] {
  return Array.from({ length: count }, (_, i) => SWEEP_SEED_BASE + i * SWEEP_SEED_STRIDE);
}

/**
 * The seed the reproducibility suite pins. Excluded from the sweep so the two
 * suites are answering about different draws, and asserted to be excluded.
 */
export const REPRODUCIBILITY_SEED = 20260726;

// ── The planar fixture ───────────────────────────────────────────────────────
// The archetype of a seed-invariant quantity: a surface whose gradient is
// written into its definition, sampled with a different noise draw each seed.
// The pipeline fixture is not planar, so this cannot come from it.

/** Planar fixture geometry. Every value pinned before any run. */
export const PLANE = {
  /** Tile side, metres. */
  extentM: 200,
  /** Grid cell, metres. 100x100 cells, 9604 of them interior. */
  cellSizeM: 2,
  /** Points drawn per fixture. 5 pts/m², about 20 returns per cell. */
  pointCount: 200_000,
  /** Along-x gradient, rise/run. */
  gradientX: 0.1,
  /** Along-y gradient, rise/run. */
  gradientY: 0,
  /** Datum offset, metres, so heights are not centred on zero. */
  baseZ: 100,
  /** Half-width of the uniform vertical noise, metres. Matches the pipeline fixture. */
  noiseHalfWidthM: 0.05,
} as const;

/**
 * Tolerance on the seed-to-seed RANGE of the planar fixture's mean slope,
 * in rise/run.
 *
 * DERIVATION, from the noise and the stencil rather than from any observation.
 * Each cell aggregates about k = 20 returns by median. The returns carry
 * uniform noise of half-width h = 0.05 m, whose density at the centre is 1/(2h),
 * so the median of k of them has variance 1/(4 k f²) = h²/k and a standard
 * deviation of 0.05/sqrt(20) = 1.12e-2 m. The Horn stencil forms each gradient
 * component as a [1 2 1] weighted difference over 8 * cellSize, so independent
 * per-cell noise of sd s propagates to sqrt(12) * s / (8 * 2) = 0.217 s, giving
 * 2.42e-3 rise/run per cell. Averaging over 9604 interior cells would divide
 * that by sqrt(9604) = 98 if the cells were independent; the stencils of
 * neighbouring cells share inputs, so an inflation factor of 3 is carried for
 * the correlation, leaving a predicted seed-to-seed sd of 7.4e-5. The range of
 * 32 normal draws is about 4 sd, so 3e-4 is the predicted range and the
 * tolerance is set at 6.0e-4, twice that.
 *
 * At a true gradient of 0.1 this is 0.6 % of the slope, and 0.034 degrees.
 *
 * The predicted sd is a bound, not a forecast: the observed range is reported
 * beside the tolerance so a reader can see how much of it the sweep used. If a
 * future run consumed the tolerance the finding would be that the propagation
 * bound above is wrong, and the bound is what would be re-derived, not the
 * tolerance widened to fit.
 */
export const PLANE_SLOPE_RANGE_TOL = 6.0e-4;

/**
 * The pipeline scalars this suite classifies. Every field of `RunScalars` that
 * is numeric appears exactly once, and a test asserts that — a scalar added to
 * the observer without a classification here is an unclassified published
 * quantity, which is the gap this file exists to close.
 */
export const PIPELINE_QUANTITIES: readonly QuantitySpec[] = [
  {
    name: 'cellSizeM',
    group: 'invariant',
    unit: 'm',
    publishedDecimals: 2,
    toleranceRange: 0,
    toleranceBasis: 'a pinned configuration value copied through the pipeline; no arithmetic touches it',
    rationale: 'set by the run options, never derived from the points',
  },
  {
    name: 'gridCols',
    group: 'invariant',
    unit: 'count',
    publishedDecimals: 0,
    toleranceRange: 0,
    toleranceBasis:
      'ceil(extent / cellSize) with 0.474 m of margin to the nearest cell boundary against a ~2 mm sample-extreme fluctuation',
    rationale: 'grid geometry follows from the pinned tile extent and cell size',
  },
  {
    name: 'gridRows',
    group: 'invariant',
    unit: 'count',
    publishedDecimals: 0,
    toleranceRange: 0,
    toleranceBasis: 'as gridCols; the tile is square',
    rationale: 'grid geometry follows from the pinned tile extent and cell size',
  },
  {
    name: 'gridCellCount',
    group: 'invariant',
    unit: 'count',
    publishedDecimals: 0,
    toleranceRange: 0,
    toleranceBasis: 'the product of two quantities each tolerated at exactly zero',
    rationale: 'gridCols * gridRows',
  },
  {
    name: 'sourcePointCount',
    group: 'variable',
    unit: 'count',
    publishedDecimals: 0,
    toleranceRange: null,
    toleranceBasis: null,
    rationale:
      'the returns the ground filter kept, which depends on where the drawn points fell relative to the buildings and canopy',
  },
  {
    name: 'analyzedPointCount',
    group: 'variable',
    unit: 'count',
    publishedDecimals: 0,
    toleranceRange: null,
    toleranceBasis: null,
    rationale: 'as sourcePointCount',
  },
  {
    name: 'elevationMinM',
    group: 'variable',
    unit: 'm',
    publishedDecimals: 2,
    toleranceRange: null,
    toleranceBasis: null,
    rationale: 'an order statistic of the draw, plus the uniform ground noise',
  },
  {
    name: 'elevationMaxM',
    group: 'variable',
    unit: 'm',
    publishedDecimals: 2,
    toleranceRange: null,
    toleranceBasis: null,
    rationale: 'an order statistic of the draw, plus the uniform ground noise',
  },
  {
    name: 'elevationRangeM',
    group: 'variable',
    unit: 'm',
    publishedDecimals: 2,
    toleranceRange: null,
    toleranceBasis: null,
    rationale: 'the difference of two order statistics',
  },
  {
    name: 'meanConfidence',
    group: 'variable',
    unit: 'index',
    publishedDecimals: 6,
    toleranceRange: null,
    toleranceBasis: null,
    rationale: 'averages a per-cell score over the returns that landed in each cell',
  },
  {
    name: 'qualityScore',
    group: 'variable',
    unit: 'index',
    publishedDecimals: 1,
    toleranceRange: null,
    toleranceBasis: null,
    rationale: 'derived from coverage and confidence, both sample properties',
  },
  {
    name: 'contourIntervalM',
    group: 'variable',
    unit: 'm',
    publishedDecimals: 2,
    toleranceRange: null,
    toleranceBasis: null,
    rationale:
      'selected from the realised relief, which is a sample property; landing on one value over a finite sweep is not invariance',
  },
  {
    name: 'contourLevelCount',
    group: 'variable',
    unit: 'count',
    publishedDecimals: 0,
    toleranceRange: null,
    toleranceBasis: null,
    rationale: 'the levels the realised relief spans at the selected interval',
  },
  {
    name: 'contourPolylineCount',
    group: 'variable',
    unit: 'count',
    publishedDecimals: 0,
    toleranceRange: null,
    toleranceBasis: null,
    rationale: 'how the realised surface breaks each level into strands',
  },
  {
    name: 'contourFeatureCount',
    group: 'variable',
    unit: 'count',
    publishedDecimals: 0,
    toleranceRange: null,
    toleranceBasis: null,
    rationale: 'as contourPolylineCount',
  },
  {
    name: 'contourLabelCount',
    group: 'variable',
    unit: 'count',
    publishedDecimals: 0,
    toleranceRange: null,
    toleranceBasis: null,
    rationale: 'label placement depends on the realised polyline geometry',
  },
];

/** The planar-fixture quantity, classified on the same terms. */
export const PLANE_QUANTITY: QuantitySpec = {
  name: 'planeMeanSlope',
  group: 'invariant',
  unit: 'rise/run',
  // Slope is published in degrees to one decimal across the application; the
  // tangent is carried here because the tolerance derivation is in tangent.
  publishedDecimals: 4,
  toleranceRange: PLANE_SLOPE_RANGE_TOL,
  toleranceBasis:
    'median-of-20-uniform cell noise of 1.12e-2 m propagated through the Horn stencil and averaged over 9604 interior cells, with a factor 3 for stencil overlap: a predicted seed-to-seed sd of 7.4e-5 and a 32-draw range of ~3e-4',
  rationale: 'the gradient is written into the surface definition; the sample contributes only zero-mean noise',
};

export const ALL_QUANTITIES: readonly QuantitySpec[] = [...PIPELINE_QUANTITIES, PLANE_QUANTITY];

export function specOf(name: string): QuantitySpec | undefined {
  return ALL_QUANTITIES.find((q) => q.name === name);
}

/**
 * Quantities that are reported but carry no distribution, because they are not
 * numbers. Named rather than silently dropped.
 *
 * `qualityBand` is a band label cut from `qualityScore`, and `applicationContentHash`
 * is a digest over the whole science payload. Both are recorded categorically by
 * the sweep: the band's distinct values are the evidence that a score sitting
 * near a band edge crosses it between seeds, and the hash's distinct count is
 * the direct contrast with the reproducibility suite, where all ten runs at one
 * seed share one hash.
 */
export const CATEGORICAL_QUANTITIES = ['qualityBand', 'applicationContentHash'] as const;

/**
 * NOT COVERED BY THIS SUITE, named because an unnamed gap reads as coverage.
 *
 * - Timing, memory and throughput. They vary with the machine far more than
 *   with the seed, so a spread measured here would be a statement about the
 *   host. The scaling suite owns them.
 * - Any quantity that only exists in the browser: GPU upload, frame rate, time
 *   to interaction, and every figure in the frozen stable protocol.
 * - Real scan data. Every fixture here comes from one synthetic generator with
 *   one surface model, so the spread reported is the spread of that generator's
 *   draws and generalises to no field dataset.
 * - Sensitivity to anything other than the seed. Point count, cell size,
 *   density, canopy fraction and the contour interval are all held fixed; this
 *   suite says nothing about how the outputs move when they change.
 * - The tails, per {@link SWEEP_SEED_COUNT}.
 */
export const UNCOVERED = [
  'timing, memory and throughput — host-dominated, owned by the scaling suite',
  'browser-only quantities: GPU upload, frame rate, time to interaction',
  'real scan data — one synthetic generator, one surface model',
  'sensitivity to any parameter other than the seed',
  'the tail behaviour of rare seeds — 32 draws bound it not at all',
] as const;
