/**
 * seedSensitivity.test.ts: do the reported results depend on the seed, and how
 * much.
 *
 * WHY THIS SUITE EXISTS. `benchmark:repro` fixes seed 20260726, runs the
 * analysis ten times and requires every science-scoped artifact hash and every
 * scalar to be identical. That establishes determinism at one seed. It is a
 * different claim from stability, and the difference is not academic: a
 * pipeline can be bit-exact on replay and still hand back a materially
 * different answer for the next draw from the same distribution, in which case
 * every published figure is a property of one fixture rather than of the
 * method. Nothing in the existing suites would notice.
 *
 * WHAT IS ASSERTED. Only the invariant group in
 * `benchmarks/seed/classification.ts` — quantities fixed by the configuration
 * or by the surface definition rather than by the sample — and only against
 * range tolerances registered there before the sweep ran, each with the
 * magnitude that justifies it.
 *
 * WHAT IS NOT ASSERTED, AND WHY NOT. The variable group. Its spread is
 * reported and nothing is required of it. A test that asserted a random
 * quantity would either hold by construction or fail at a rate nobody chose.
 * An earlier proposal in this program — assert run 1 falls inside the IQR of
 * runs 2..n — is the specific shape being avoided: under a stationary process
 * it fails about half the time, so its pass rate carries no information about
 * the pipeline. A check whose null pass rate is not the rate its author
 * intended is the wrong check.
 *
 * THE NEGATIVE CONTROLS are at the bottom. Each perturbs a passing observation
 * set by a stated amount and requires the evaluator to report the violation, so
 * the assertions above are known to be capable of failing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, test, expect, beforeAll } from 'vitest';

import { generateSyntheticCloud } from '../../benchmarks/fixtures/syntheticCloud';
import {
  ALL_QUANTITIES,
  CATEGORICAL_QUANTITIES,
  PIPELINE_QUANTITIES,
  PLANE,
  PLANE_QUANTITY,
  PLANE_SLOPE_RANGE_TOL,
  REPRODUCIBILITY_SEED,
  SWEEP_CELL_SIZE_M,
  SWEEP_POINT_COUNT,
  SWEEP_SEED_COUNT,
  UNCOVERED,
  sweepSeeds,
} from '../../benchmarks/seed/classification';
import { renderSeedSummary } from '../../benchmarks/seed/render';
import {
  evaluateSweep,
  mulberry32,
  planeObservation,
  runSweep,
  sweepIsDisjointFromReproducibility,
  type SweepEvaluation,
  type SweepObservations,
} from '../../benchmarks/seed/sweep';

const OUT_DIR = join(process.cwd(), 'benchmark-results', 'seeds');

let observations: SweepObservations;
let evaluation: SweepEvaluation;

beforeAll(() => {
  observations = runSweep();
  evaluation = evaluateSweep(observations);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'sweep.json'), `${JSON.stringify(evaluation, null, 2)}\n`, 'utf8');
  writeFileSync(join(OUT_DIR, 'summary.md'), renderSeedSummary(evaluation), 'utf8');
}, 1_800_000);

// ── The registration is complete before anything is judged ───────────────────

describe('pre-registration', () => {
  test('every numeric scalar the observer publishes carries a classification', () => {
    const observed = Object.entries(observations.pipeline[0].scalars)
      .filter(([, v]) => typeof v === 'number')
      .map(([k]) => k)
      .sort();
    const classified = PIPELINE_QUANTITIES.map((q) => q.name).sort();
    expect(classified).toEqual(observed);
  });

  test('the non-numeric scalars are named rather than dropped', () => {
    const observed = Object.entries(observations.pipeline[0].scalars)
      .filter(([, v]) => typeof v !== 'number')
      .map(([k]) => k)
      .sort();
    expect([...CATEGORICAL_QUANTITIES].sort()).toEqual(observed);
  });

  test('every invariant quantity carries a tolerance and the magnitude behind it', () => {
    for (const q of ALL_QUANTITIES) {
      if (q.group !== 'invariant') continue;
      expect(q.toleranceRange, q.name).not.toBeNull();
      expect(q.toleranceRange, q.name).toBeGreaterThanOrEqual(0);
      expect((q.toleranceBasis ?? '').length, q.name).toBeGreaterThan(20);
    }
  });

  test('no variable quantity carries a tolerance, because nothing is asserted about it', () => {
    for (const q of ALL_QUANTITIES) {
      if (q.group !== 'variable') continue;
      expect(q.toleranceRange, q.name).toBeNull();
    }
  });

  test('the gaps are named', () => {
    expect(UNCOVERED.length).toBeGreaterThan(0);
  });
});

// ── The sweep is a different question from the reproducibility suite ─────────

describe('the sweep', () => {
  test('draws the registered number of distinct seeds', () => {
    expect(observations.seeds).toHaveLength(SWEEP_SEED_COUNT);
    expect(new Set(observations.seeds).size).toBe(SWEEP_SEED_COUNT);
    expect(observations.pipeline).toHaveLength(SWEEP_SEED_COUNT);
    expect(observations.plane).toHaveLength(SWEEP_SEED_COUNT);
  });

  test('shares no seed with the reproducibility suite', () => {
    expect(observations.seeds).not.toContain(REPRODUCIBILITY_SEED);
    expect(sweepIsDisjointFromReproducibility(observations.seeds)).toBe(true);
    expect(sweepIsDisjointFromReproducibility([...observations.seeds, REPRODUCIBILITY_SEED])).toBe(false);
  });

  test('runs at the registered fixture size', () => {
    expect(observations.pointCount).toBe(SWEEP_POINT_COUNT);
    expect(observations.cellSizeM).toBe(SWEEP_CELL_SIZE_M);
  });

  /**
   * The sweep runs with `isolateLeaves: false`, so the two isolated leaves and
   * their artifacts are declared not-requested rather than produced. They are a
   * second timing of work the `dtm` stage already did and this suite reads no
   * timing at all. The exact set is asserted rather than the check loosened: a
   * science artifact going missing must still be a failure.
   */
  const LEAF_ARTIFACTS = ['rasterSummary', 'rasterZBytes', 'descriptors'];

  test('every run completed every stage it was asked for', () => {
    for (const o of observations.pipeline) {
      expect(o.failedStages, `seed ${o.seed}`).toEqual([]);
      expect([...o.missingArtifacts].sort(), `seed ${o.seed}`).toEqual([...LEAF_ARTIFACTS].sort());
      expect(o.manifestVerified, `seed ${o.seed}`).toBe(true);
    }
  });

  test('collected a value for every classified quantity', () => {
    expect(evaluation.missing).toEqual([]);
  });

  /**
   * The contrast with `benchmark:repro` stated as an assertion rather than as
   * prose. Ten runs at one seed share one content hash; these seeds must not,
   * or the fixtures are not independent draws and the whole sweep measures
   * nothing.
   */
  test('a different seed produces a different science payload', () => {
    const hashes = evaluation.categorical.find((c) => c.name === 'applicationContentHash');
    expect(hashes?.distinctCount).toBe(SWEEP_SEED_COUNT);
  });
});

// ── The invariant group ──────────────────────────────────────────────────────

describe('quantities that must not depend on the draw', () => {
  test('none exceeded its pre-registered tolerance', () => {
    expect(evaluation.invariantViolations).toEqual([]);
  });

  test('the grid geometry is identical on every seed', () => {
    for (const name of ['gridCols', 'gridRows', 'gridCellCount', 'cellSizeM']) {
      const q = evaluation.quantities.find((x) => x.name === name);
      expect(q?.distinctCount, name).toBe(1);
      expect(q?.range, name).toBe(0);
    }
  });

  /**
   * The archetype. The plane's gradient is in its definition; the draw only
   * adds zero-mean noise, so the fitted slope has to come back to the same
   * number whichever points were drawn. The tolerance is a noise-propagation
   * bound derived in `classification.ts`, not a figure read off this run.
   */
  test('the fitted slope of a planar fixture is seed-invariant', () => {
    const q = evaluation.quantities.find((x) => x.name === PLANE_QUANTITY.name);
    expect(q).toBeDefined();
    expect(q!.range).toBeLessThanOrEqual(PLANE_SLOPE_RANGE_TOL);
  });

  /**
   * Accuracy against the analytic gradient, reported rather than asserted at
   * the invariance tolerance: Horn over a noisy raster biases the mean of a
   * magnitude upward, and that bias is a property of the estimator, identical
   * on every seed, so it belongs nowhere near an invariance check. The loose
   * bound below only catches a fixture that stopped describing this plane.
   */
  test('the planar fixture still describes the plane it declares', () => {
    const truth = Math.hypot(PLANE.gradientX, PLANE.gradientY);
    const q = evaluation.quantities.find((x) => x.name === PLANE_QUANTITY.name);
    expect(Math.abs(q!.summary.mean - truth)).toBeLessThan(0.01 * truth);
  });

  test('the planar fixture averages over the interior cells it claims', () => {
    const expectedCols = Math.ceil(PLANE.extentM / PLANE.cellSizeM);
    for (const p of observations.plane) {
      expect(p.cols, `seed ${p.seed}`).toBe(expectedCols);
      expect(p.rows, `seed ${p.seed}`).toBe(expectedCols);
      expect(p.cellsAveraged, `seed ${p.seed}`).toBe((expectedCols - 2) * (expectedCols - 2));
    }
  });

  /**
   * The planar fixture reproduces the fixture generator's PRNG rather than
   * importing it, because `syntheticCloud.ts` keeps it private. Two copies of
   * an integer stream drift silently, so they are pinned against each other
   * here: the generator's first draw becomes the first point's x.
   */
  test('the planar fixture draws from the same stream as the cloud generator', () => {
    const seed = 4242;
    const cloud = generateSyntheticCloud({ seed, pointCount: 1000 });
    const rnd = mulberry32(seed);
    expect(cloud.positions[0]).toBeCloseTo(rnd() * cloud.extentM, 4);
  });
});

// ── The variable group ───────────────────────────────────────────────────────

describe('quantities that legitimately follow the draw', () => {
  test('each carries a full spread and no verdict', () => {
    const variable = evaluation.quantities.filter((q) => q.group === 'variable');
    expect(variable.length).toBe(PIPELINE_QUANTITIES.filter((q) => q.group === 'variable').length);
    for (const q of variable) {
      expect(q.summary.count, q.name).toBe(SWEEP_SEED_COUNT);
      expect(q.summary.stdDev, q.name).not.toBeNull();
      expect(Number.isFinite(q.summary.mean), q.name).toBe(true);
      expect(Number.isFinite(q.summary.min), q.name).toBe(true);
      expect(Number.isFinite(q.summary.max), q.name).toBe(true);
    }
  });

  test('at least one of them actually moved, or the sweep is not sampling', () => {
    const moved = evaluation.quantities.filter((q) => q.group === 'variable' && q.range > 0);
    expect(moved.length).toBeGreaterThan(0);
  });

  test('the CV interval is stated with the estimate', () => {
    expect(evaluation.cvRelativeStandardError).toBeCloseTo(1 / Math.sqrt(2 * (SWEEP_SEED_COUNT - 1)), 12);
  });
});

// ── Precision ────────────────────────────────────────────────────────────────

describe('reported precision against measured spread', () => {
  /**
   * A finding, not a failure. A quantity that genuinely varies with the sample
   * is not a defect; publishing it to six decimals is a reporting problem, and
   * failing the suite on it would make the red light permanent and useless.
   * What the suite requires is that every such quantity is found and named, and
   * that the finder can distinguish a quantity that fits its published quantum
   * from one that does not.
   */
  test('every finding names a classified quantity and its published quantum', () => {
    for (const f of evaluation.precisionFindings) {
      const spec = ALL_QUANTITIES.find((q) => q.name === f.name);
      expect(spec, f.name).toBeDefined();
      expect(f.publishedQuantum).toBeCloseTo(Math.pow(10, -spec!.publishedDecimals), 12);
      expect(f.stdDev).toBeGreaterThan(f.publishedQuantum);
      expect(f.supportedDecimals).toBeLessThanOrEqual(f.publishedDecimals);
    }
  });

  test('a quantity whose spread fits its published quantum is not reported as a finding', () => {
    for (const q of evaluation.quantities) {
      const spec = ALL_QUANTITIES.find((s) => s.name === q.name)!;
      const sd = q.summary.stdDev;
      if (sd === null || sd > Math.pow(10, -spec.publishedDecimals)) continue;
      expect(evaluation.precisionFindings.map((f) => f.name)).not.toContain(q.name);
    }
  });
});

// ── The report ───────────────────────────────────────────────────────────────

describe('the rendered report', () => {
  test('prints every quantity, both groups, and the uncovered list', () => {
    const md = renderSeedSummary(evaluation);
    for (const q of ALL_QUANTITIES) expect(md).toContain(`\`${q.name}\``);
    for (const u of UNCOVERED) expect(md).toContain(u);
    expect(md).toContain('reported, not asserted');
  });

  test('states what n can and cannot resolve', () => {
    const md = renderSeedSummary(evaluation);
    expect(md).toContain('relative standard error of a CV');
    expect(md).toContain('most extreme of');
  });
});

// ── Negative controls ────────────────────────────────────────────────────────
//
// Each perturbs a passing observation set by a stated amount and requires the
// evaluator to react. Without these the assertions above are untested.

function perturbedPipeline(
  base: SweepObservations,
  index: number,
  field: string,
  delta: number,
): SweepObservations {
  const pipeline = base.pipeline.map((o, i) =>
    i === index
      ? { ...o, scalars: { ...o.scalars, [field]: (o.scalars as unknown as Record<string, number>)[field] + delta } }
      : o,
  );
  return { ...base, pipeline };
}

describe('negative controls', () => {
  test('one extra grid column on one seed is reported as a violation', () => {
    const ev = evaluateSweep(perturbedPipeline(observations, 7, 'gridCols', 1));
    expect(ev.invariantViolations.map((v) => v.name)).toContain('gridCols');
    const v = ev.invariantViolations.find((x) => x.name === 'gridCols')!;
    expect(v.range).toBe(1);
    expect(v.tolerance).toBe(0);
  });

  test('a cell size that drifted by a millimetre on one seed is reported', () => {
    const ev = evaluateSweep(perturbedPipeline(observations, 0, 'cellSizeM', 0.001));
    expect(ev.invariantViolations.map((v) => v.name)).toContain('cellSizeM');
  });

  test('a plane slope moved just past its tolerance is reported', () => {
    const plane = observations.plane.map((p, i) =>
      i === 3 ? { ...p, meanSlope: p.meanSlope + PLANE_SLOPE_RANGE_TOL * 1.5 } : p,
    );
    const ev = evaluateSweep({ ...observations, plane });
    expect(ev.invariantViolations.map((v) => v.name)).toContain(PLANE_QUANTITY.name);
  });

  test('a plane slope moved to just inside its tolerance is not reported', () => {
    const plane = observations.plane.map((p, i) =>
      i === 3 ? { ...p, meanSlope: p.meanSlope + PLANE_SLOPE_RANGE_TOL * 0.4 } : p,
    );
    const ev = evaluateSweep({ ...observations, plane });
    expect(ev.invariantViolations.map((v) => v.name)).not.toContain(PLANE_QUANTITY.name);
  });

  test('a quantity that stops being produced is reported missing, never as passing', () => {
    const pipeline = observations.pipeline.map((o) => ({
      ...o,
      scalars: { ...o.scalars, gridCols: null },
    }));
    const ev = evaluateSweep({ ...observations, pipeline } as SweepObservations);
    expect(ev.missing).toContain('gridCols');
    expect(ev.quantities.map((q) => q.name)).not.toContain('gridCols');
    expect(ev.invariantViolations.map((v) => v.name)).not.toContain('gridCols');
  });

  test('a spread widened past a published quantum becomes a precision finding', () => {
    const before = evaluateSweep(observations).precisionFindings.map((f) => f.name);
    expect(before).not.toContain('gridCellCount');
    // gridCellCount is published as an integer, so the quantum is 1 and the
    // perturbation has to lift the sample sd past it: one seed moved by 20
    // gives sd = 20 * sqrt(31/32) / sqrt(31) = 3.5.
    const ev = evaluateSweep(perturbedPipeline(observations, 5, 'gridCellCount', 20));
    expect(ev.precisionFindings.map((f) => f.name)).toContain('gridCellCount');
  });

  test('the planar fixture reacts to a different seed', () => {
    const a = planeObservation(11);
    const b = planeObservation(12);
    expect(a.meanSlope).not.toBe(b.meanSlope);
    expect(Math.abs(a.meanSlope - b.meanSlope)).toBeLessThan(PLANE_SLOPE_RANGE_TOL);
  });

  test('a sweep seed set colliding with the reproducibility seed is caught', () => {
    expect(sweepIsDisjointFromReproducibility(sweepSeeds(4))).toBe(true);
    expect(sweepIsDisjointFromReproducibility([1, REPRODUCIBILITY_SEED])).toBe(false);
  });
});
