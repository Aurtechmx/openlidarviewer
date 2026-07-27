/**
 * sweep.ts: run the analysis over N independently seeded fixtures drawn from
 * one generator, and turn the results into a spread per published quantity.
 *
 * The measuring and the judging are separated on purpose. `sweepSeeds` drives
 * the pipeline and returns raw observations; `evaluateSweep` is pure over those
 * observations and decides nothing else. A negative control can therefore hand
 * `evaluateSweep` a perturbed observation set and prove the invariant check
 * says no, without a mocked pipeline anywhere in the picture.
 *
 * WHAT IS ASSERTED AND WHAT IS NOT. Only the invariant group is asserted, and
 * only against a range tolerance pre-registered in `classification.ts`. The
 * variable group gets mean, sd, CV, min, max and n, and no verdict. There is a
 * specific trap this avoids: a check of the form "run 1 falls inside the IQR of
 * the rest" reads like a stability test and, under a stationary process, fails
 * about half the time by construction. A check whose pass rate under the null
 * is not the rate its author intended is the wrong check, whichever way it
 * points.
 */

import {
  runOlvPipeline,
  DEFAULT_CRS,
  DEFAULT_VERTICAL_DATUM,
} from '../pipeline/runPipeline';
import { observeRun, type RunObservation } from '../runner/observe';
import { summariseSeries, QUANTILE_CONVENTION, type SeriesSummary } from '../runner/stats';
import { rasterizeDtm } from '../../src/terrain/ground/rasterizeDtm';
import { hornSlopeAspect } from '../../src/terrain/ground/terrainDerivatives';
import {
  ALL_QUANTITIES,
  CATEGORICAL_QUANTITIES,
  PIPELINE_QUANTITIES,
  PLANE,
  PLANE_QUANTITY,
  REPRODUCIBILITY_SEED,
  SWEEP_CELL_SIZE_M,
  SWEEP_POINT_COUNT,
  SWEEP_SEED_COUNT,
  sweepSeeds,
  type QuantitySpec,
} from './classification';

// ── The planar fixture ───────────────────────────────────────────────────────

/**
 * The fixture generator's PRNG, reproduced here rather than imported.
 *
 * `syntheticCloud.ts` keeps `mulberry32` private and generates a specific
 * terrain; the planar fixture needs the same integer-exact stream over a
 * different surface. The two copies are pinned together by a test that draws
 * the same seed through both and compares the streams, so a change to the
 * generator's PRNG shows up as a red test rather than as two fixtures that
 * quietly stopped sampling the same way.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlaneObservation {
  readonly seed: number;
  readonly cols: number;
  readonly rows: number;
  /** Interior cells with coverage and a finite slope — the averaging basis. */
  readonly cellsAveraged: number;
  /** Mean Horn slope over those cells, rise/run. */
  readonly meanSlope: number;
}

/**
 * One planar fixture: uniform draws over a square tile on a plane of known
 * gradient, with uniform vertical noise, rasterised and differenced by the
 * production functions.
 *
 * The interior cells only. The Horn stencil clamps at the border, which halves
 * one difference and biases the edge row; including it would mix a boundary
 * artefact into a quantity this suite asserts on.
 */
export function planeObservation(seed: number): PlaneObservation {
  const rnd = mulberry32(seed);
  const n = PLANE.pointCount;
  const pts = new Array<{ x: number; y: number; z: number }>(n);
  for (let i = 0; i < n; i++) {
    const x = rnd() * PLANE.extentM;
    const y = rnd() * PLANE.extentM;
    const noise = (rnd() * 2 - 1) * PLANE.noiseHalfWidthM;
    pts[i] = {
      x,
      y,
      z: PLANE.baseZ + PLANE.gradientX * x + PLANE.gradientY * y + noise,
    };
  }
  const isGround = new Uint8Array(n).fill(1);
  const raster = rasterizeDtm(pts, isGround, {
    cellSizeM: PLANE.cellSizeM,
    aggregation: 'median',
  });
  const { slope } = hornSlopeAspect(
    raster.z,
    raster.cols,
    raster.rows,
    PLANE.cellSizeM,
    PLANE.cellSizeM,
    1,
  );

  let sum = 0;
  let cells = 0;
  for (let row = 1; row < raster.rows - 1; row++) {
    for (let col = 1; col < raster.cols - 1; col++) {
      const i = row * raster.cols + col;
      // `counts`, not `coverage`: the latter is the raster's coverage MODE, a
      // string, and indexing it would never equal 0 — a filter that silently
      // did nothing. An empty cell is one that received no ground return.
      if (raster.counts[i] === 0) continue;
      const s = slope[i];
      if (!Number.isFinite(s)) continue;
      sum += s;
      cells++;
    }
  }
  if (cells === 0) throw new Error('planeObservation: no interior cell carried a finite slope');
  return { seed, cols: raster.cols, rows: raster.rows, cellsAveraged: cells, meanSlope: sum / cells };
}

// ── Running the sweep ────────────────────────────────────────────────────────

export interface SweepObservations {
  readonly seeds: readonly number[];
  readonly pointCount: number;
  readonly cellSizeM: number;
  readonly pipeline: readonly RunObservation[];
  readonly plane: readonly PlaneObservation[];
}

export interface RunSweepOptions {
  readonly seedCount?: number;
  readonly pointCount?: number;
}

/** Drive the pipeline and the planar fixture once per seed. */
export function runSweep(options: RunSweepOptions = {}): SweepObservations {
  const seeds = sweepSeeds(options.seedCount ?? SWEEP_SEED_COUNT);
  const pointCount = options.pointCount ?? SWEEP_POINT_COUNT;
  const pipeline: RunObservation[] = [];
  const plane: PlaneObservation[] = [];
  for (const [index, seed] of seeds.entries()) {
    const run = runOlvPipeline({
      seed,
      pointCount,
      cellSizeM: SWEEP_CELL_SIZE_M,
      crs: DEFAULT_CRS,
      verticalDatum: DEFAULT_VERTICAL_DATUM,
      // The isolated leaves re-run the SMRF pass for a timing this suite never
      // reads. Turning them off roughly halves the sweep and changes no output.
      isolateLeaves: false,
    });
    pipeline.push(
      observeRun(run, {
        index,
        startRssBytes: null,
        endRssBytes: null,
        startHeapUsedBytes: null,
        endHeapUsedBytes: null,
        forcedGcAvailable: false,
      }),
    );
    plane.push(planeObservation(seed));
  }
  return { seeds, pointCount, cellSizeM: SWEEP_CELL_SIZE_M, pipeline, plane };
}

// ── Judging the sweep ────────────────────────────────────────────────────────

export interface QuantitySpread {
  readonly name: string;
  readonly group: 'invariant' | 'variable';
  readonly unit: string;
  readonly summary: SeriesSummary;
  /** max − min across seeds. */
  readonly range: number;
  /** Distinct values observed, capped for reporting. */
  readonly distinctCount: number;
}

export interface InvariantViolation {
  readonly name: string;
  readonly range: number;
  readonly tolerance: number;
  readonly min: number;
  readonly max: number;
  readonly toleranceBasis: string;
}

/**
 * A quantity whose seed-to-seed spread is larger than the quantum it is
 * published at: the published figure carries digits the measurement does not
 * support.
 *
 * The comparison is against the sample standard deviation rather than the
 * range, because sd is the scale a reader would attach to a single figure and
 * the range grows with n while sd does not.
 */
export interface PrecisionFinding {
  readonly name: string;
  readonly unit: string;
  readonly stdDev: number;
  readonly publishedDecimals: number;
  /** 10^-publishedDecimals. */
  readonly publishedQuantum: number;
  /** Decimals the spread actually supports: floor(-log10(sd)), floored at 0. */
  readonly supportedDecimals: number;
}

export interface CategoricalSpread {
  readonly name: string;
  readonly distinctCount: number;
  /** Value to count, sorted by descending count then value. */
  readonly counts: readonly (readonly [string, number])[];
}

export interface SweepEvaluation {
  readonly seedCount: number;
  readonly seeds: readonly number[];
  readonly pointCount: number;
  readonly cellSizeM: number;
  readonly quantileConvention: string;
  readonly quantities: readonly QuantitySpread[];
  readonly invariantViolations: readonly InvariantViolation[];
  readonly precisionFindings: readonly PrecisionFinding[];
  readonly categorical: readonly CategoricalSpread[];
  /** Relative standard error of a CV at this n: 1/sqrt(2(n-1)). */
  readonly cvRelativeStandardError: number;
  /** Quantities in the classification for which no value was collected. */
  readonly missing: readonly string[];
}

function numericSeries(
  observations: readonly RunObservation[],
  name: string,
): readonly number[] | null {
  const out: number[] = [];
  for (const o of observations) {
    const v = (o.scalars as unknown as Record<string, unknown>)[name];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out.push(v);
  }
  return out.length === 0 ? null : out;
}

function spreadOf(spec: QuantitySpec, values: readonly number[]): QuantitySpread {
  const summary = summariseSeries(values);
  return {
    name: spec.name,
    group: spec.group,
    unit: spec.unit,
    summary,
    range: summary.max - summary.min,
    distinctCount: new Set(values).size,
  };
}

function categoricalOf(observations: readonly RunObservation[], name: string): CategoricalSpread {
  const counts = new Map<string, number>();
  for (const o of observations) {
    const v = (o.scalars as unknown as Record<string, unknown>)[name];
    const key = v === null || v === undefined ? '(absent)' : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { name, distinctCount: counts.size, counts: sorted };
}

/**
 * Judge a set of observations. Pure — the same input always yields the same
 * verdict, which is what lets a negative control perturb one value and prove
 * the check reacts.
 */
export function evaluateSweep(observations: SweepObservations): SweepEvaluation {
  const quantities: QuantitySpread[] = [];
  const missing: string[] = [];

  for (const spec of PIPELINE_QUANTITIES) {
    const values = numericSeries(observations.pipeline, spec.name);
    if (values === null) {
      missing.push(spec.name);
      continue;
    }
    quantities.push(spreadOf(spec, values));
  }

  if (observations.plane.length > 0) {
    quantities.push(spreadOf(PLANE_QUANTITY, observations.plane.map((p) => p.meanSlope)));
  } else {
    missing.push(PLANE_QUANTITY.name);
  }

  const invariantViolations: InvariantViolation[] = [];
  for (const q of quantities) {
    if (q.group !== 'invariant') continue;
    const spec = ALL_QUANTITIES.find((s) => s.name === q.name);
    if (!spec || spec.toleranceRange === null) continue;
    if (q.range > spec.toleranceRange) {
      invariantViolations.push({
        name: q.name,
        range: q.range,
        tolerance: spec.toleranceRange,
        min: q.summary.min,
        max: q.summary.max,
        toleranceBasis: spec.toleranceBasis ?? '',
      });
    }
  }

  const precisionFindings: PrecisionFinding[] = [];
  for (const q of quantities) {
    const spec = ALL_QUANTITIES.find((s) => s.name === q.name);
    if (!spec) continue;
    const sd = q.summary.stdDev;
    if (sd === null || sd === 0) continue;
    const quantum = Math.pow(10, -spec.publishedDecimals);
    if (sd > quantum) {
      precisionFindings.push({
        name: q.name,
        unit: q.unit,
        stdDev: sd,
        publishedDecimals: spec.publishedDecimals,
        publishedQuantum: quantum,
        supportedDecimals: Math.max(0, Math.floor(-Math.log10(sd))),
      });
    }
  }

  const n = observations.pipeline.length;
  return {
    seedCount: n,
    seeds: observations.seeds,
    pointCount: observations.pointCount,
    cellSizeM: observations.cellSizeM,
    quantileConvention: QUANTILE_CONVENTION,
    quantities,
    invariantViolations,
    precisionFindings,
    categorical: CATEGORICAL_QUANTITIES.map((name) => categoricalOf(observations.pipeline, name)),
    cvRelativeStandardError: n < 2 ? Number.NaN : 1 / Math.sqrt(2 * (n - 1)),
    missing,
  };
}

/** True when no seed in the sweep collides with the pinned reproducibility seed. */
export function sweepIsDisjointFromReproducibility(seeds: readonly number[]): boolean {
  return !seeds.includes(REPRODUCIBILITY_SEED);
}
