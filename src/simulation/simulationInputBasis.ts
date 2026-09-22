/**
 * simulationInputBasis.ts — what a simulation was allowed to read, declared.
 *
 * A simulation result is only as good as the thing it ran on, and the two
 * facts that decide this are not visible in the numbers it produces. A flow
 * field computed over a DTM built from one streamed tile looks exactly like
 * one computed over the whole survey. So the basis travels with the run
 * rather than being inferred from it.
 *
 * ── WHY THIS REUSES TERRAIN'S VOCABULARY ────────────────────────────────────
 * `TerrainCoverageMode` already answers "how much of the source did this
 * see": `full`, `resident-only`, `sampled`. A second enum saying the same
 * thing in different words is how two parts of a codebase start disagreeing
 * about the same dataset, so this imports that one. The DTM already carries
 * it, which means the honest answer is available rather than assumed.
 *
 * ── WHY WITHHELD IS A TRISTATE ──────────────────────────────────────────────
 * `withheldExcluded` is `true`, `false`, or `null` for undeclared, and the
 * third is the common case today. `src/science/withheldPolicy.ts` states the
 * project's rule — scientific processing excludes Withheld points unless
 * asked otherwise — and has no callers anywhere in `src/`, so no DTM in this
 * tree can currently claim the exclusion was applied.
 *
 * Defaulting that to `false` would be a lie in the safe-looking direction,
 * and defaulting it to `true` would be a lie in the dangerous one. `null`
 * forces the question to reach the reader as a limitation instead of being
 * silently resolved. When the policy is applied to the terrain path, the
 * rasteriser can declare it and this field stops being null without anything
 * here changing.
 *
 * Pure data: no DOM, no three.js, no I/O.
 */

import type { TerrainCoverageMode } from '../terrain/TerrainContracts';

/** What a simulation read, and what it is entitled to say about it. */
export interface SimulationInputBasis {
  /** How much of the source the terrain product behind this saw. */
  readonly coverage: TerrainCoverageMode;
  /** True only when coverage is `full`: every point offered was walked. */
  readonly complete: boolean;
  /**
   * Whether Withheld points were left out of the input, or null when the
   * producer did not say. Null is not "no".
   */
  readonly withheldExcluded: boolean | null;
  /**
   * Whether the horizontal scale is known in metres. False withholds every
   * figure quoted in square metres or metres per metre.
   */
  readonly horizontalScaleResolved: boolean;
  /** Cells carrying an elevation the model may read. */
  readonly measuredCells: number;
  /**
   * Of those, cells whose elevation was interpolated rather than measured.
   * Zero when the producer did not distinguish the two, which is not the same
   * as none: `DemRaster` carries no such distinction, while `DtmGrid` does.
   */
  readonly interpolatedCells: number;
  /**
   * Cells that hold an elevation but were left out by the caller's policy,
   * such as interpolated cells under a measured-only setting. Kept apart from
   * cells with no elevation, because the reader should be told the height was
   * excluded rather than that there was none.
   */
  readonly policyExcludedCells: number;
  /** Cells in the grid, readable or not. */
  readonly totalCells: number;
}

/** Build a basis from what the caller actually knows. */
export function simulationInputBasis(input: {
  readonly coverage: TerrainCoverageMode;
  readonly withheldExcluded?: boolean | null;
  readonly horizontalScaleResolved: boolean;
  readonly measuredCells: number;
  readonly interpolatedCells?: number;
  readonly policyExcludedCells?: number;
  readonly totalCells: number;
}): SimulationInputBasis {
  return {
    coverage: input.coverage,
    complete: input.coverage === 'full',
    withheldExcluded: input.withheldExcluded ?? null,
    horizontalScaleResolved: input.horizontalScaleResolved,
    measuredCells: input.measuredCells,
    interpolatedCells: input.interpolatedCells ?? 0,
    policyExcludedCells: input.policyExcludedCells ?? 0,
    totalCells: input.totalCells,
  };
}

/**
 * The limitations a result carrying this basis must display.
 *
 * Returned as sentences rather than codes because they are shown to a reader
 * and written into the export README, and a code would have to be translated
 * in both places. An empty array means the basis imposes none, which is not
 * the same as the result being validated.
 */
export function basisLimitations(basis: SimulationInputBasis): readonly string[] {
  const out: string[] = [];

  if (basis.coverage === 'resident-only') {
    out.push(
      'The terrain behind this run was built from the resident streamed subset, '
      + 'not the whole source. Results describe the part that was loaded.',
    );
  } else if (basis.coverage === 'sampled') {
    out.push(
      'The terrain behind this run was built from a sample of the source, '
      + 'so cells away from the sampled returns rest on fewer measurements.',
    );
  }

  if (basis.withheldExcluded === null) {
    out.push(
      'Whether points flagged Withheld were excluded is not recorded for this '
      + 'input, so the run cannot state it either way.',
    );
  } else if (basis.withheldExcluded === false) {
    out.push(
      'Points flagged Withheld were read as ordinary returns, including any the '
      + 'producer marked as not to be used.',
    );
  }

  if (!basis.horizontalScaleResolved) {
    out.push(
      'The horizontal scale is unresolved, so areas and distances in metres are '
      + 'withheld. Cell counts remain available.',
    );
  }

  if (basis.interpolatedCells > 0) {
    out.push(
      `${basis.interpolatedCells} of ${basis.measuredCells} readable cells hold an `
      + 'interpolated elevation rather than a measured one. Flow routes over them, '
      + 'so a path may cross ground no return landed on.',
    );
  }

  if (basis.policyExcludedCells > 0) {
    out.push(
      `${basis.policyExcludedCells} cells hold an interpolated elevation that the `
      + 'measured-only setting left out, so routes stop at their edge.',
    );
  }

  const absent = basis.totalCells - basis.measuredCells - basis.policyExcludedCells;
  if (basis.totalCells > 0 && absent > 0) {
    const gap = absent;
    out.push(
      `${gap} of ${basis.totalCells} cells carry no elevation. Flow neither `
      + 'enters nor leaves them, so routes stop at their edge.',
    );
  }

  return out;
}

/**
 * Whether a run may report figures in square metres.
 *
 * One function so the rule lives in one place: every caller that formats an
 * area asks this rather than re-deriving it from the basis fields, which is
 * how one caller ends up with a different answer from the others.
 */
export function mayReportMetricArea(basis: SimulationInputBasis): boolean {
  return basis.horizontalScaleResolved;
}
