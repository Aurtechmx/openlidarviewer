/**
 * dtmFlowGrid.ts — the seam between the canonical DTM and the routing core.
 *
 * `d8Flow` deliberately knows nothing about `DemRaster`, so that a 3×3
 * terrain can be written by hand in a test. This is the one module that knows
 * both, and it exists to make two translations explicit rather than incidental.
 *
 * NaN is NoData. `rasterizeDtm` leaves `z[i]` as NaN for a cell that received
 * no ground return, which is its honest "no data here" state. That becomes
 * `valid[i] = 0`, so a cell with no measurement is a wall rather than an
 * elevation of zero. Copying the raster's z straight into a routing grid
 * without this step would put a sea-level hole under every gap in the survey
 * and drain the whole surface into it.
 *
 * Cell size becomes two lengths. A DTM carries one `cellSizeM`, which is a
 * length in the source's horizontal unit; the metric size of a cell differs
 * per axis on a geographic grid. `horizontalCellMetresXY` is the project's
 * existing answer and the same one the slope estimator uses, so routing and
 * slope cannot disagree about how long a cell is.
 *
 * This module does not decide anything about Withheld points. It cannot: the
 * raster arrives with the decision already made, or not made, upstream of it.
 * What it does is carry that declaration through, so a run says which it was.
 */

import { horizontalCellMetresXY } from '../../terrain/ground/horizontalScale';
import { simulationInputBasis, type SimulationInputBasis } from '../simulationInputBasis';
import type { DemRaster } from '../../terrain/ground/rasterizeDtm';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';
import type { FlowGrid } from './flowTypes';

/** `CellCoverage` values, named so the comparison below reads as intent. */
const COVERAGE_NONE = 0;
const COVERAGE_INTERPOLATED = 1;

/** How the source's horizontal coordinates relate to metres. */
export interface HorizontalScale {
  /** A geographic (degrees) frame scales the east–west axis by cos φ. */
  readonly isGeographic: boolean;
  /** Representative latitude for that scaling; null when unknown. */
  readonly latitudeDeg: number | null;
  /** Source horizontal unit expressed in metres, for a projected frame. */
  readonly unitToMetres: number;
  /**
   * Whether the above is known rather than assumed. False still produces a
   * routable grid, because direction is computable from relative lengths;
   * what it withholds is every figure quoted in metres.
   */
  readonly resolved: boolean;
}

/** A routing grid built from a DTM, with the basis it was built on. */
export interface DtmFlowGrid {
  readonly grid: FlowGrid;
  readonly basis: SimulationInputBasis;
}

/** What a routing pass does with a cell whose height was interpolated. */
export type InterpolatedPolicy =
  /** Route over it, and disclose how many there were. */
  | 'route'
  /** Treat it as absent, so only measured ground carries flow. */
  | 'block';

/**
 * Convert a DTM raster into a routing grid.
 *
 * `withheldExcluded` is the caller's declaration about the points behind the
 * raster, and defaults to undeclared. It is a parameter rather than something
 * read from `dem` because `DemRaster` carries no such field: nothing in this
 * tree applies the Withheld policy yet, so any value inferred here would be
 * invented.
 */
export function dtmToFlowGrid(
  dem: DemRaster,
  scale: HorizontalScale,
  withheldExcluded: boolean | null = null,
): DtmFlowGrid {
  const n = dem.cols * dem.rows;
  const z = new Float32Array(n);
  const valid = new Uint8Array(n);

  let measuredCells = 0;
  for (let i = 0; i < n; i++) {
    const v = dem.z[i];
    if (!Number.isFinite(v)) continue; // NaN, and any infinity, is absence
    z[i] = v;
    valid[i] = 1;
    measuredCells++;
  }

  const metres = horizontalCellMetresXY(
    dem.cellSizeM,
    scale.isGeographic,
    scale.latitudeDeg,
    scale.unitToMetres,
  );

  return {
    grid: {
      z,
      valid,
      cols: dem.cols,
      rows: dem.rows,
      cellMetresX: metres.x,
      cellMetresY: metres.y,
    },
    basis: simulationInputBasis({
      coverage: dem.coverage,
      withheldExcluded,
      horizontalScaleResolved: scale.resolved,
      measuredCells,
      totalCells: n,
    }),
  };
}

/**
 * Convert the analysed DTM into a routing grid.
 *
 * This is the adapter the application uses; `dtmToFlowGrid` above takes the
 * rasteriser's raw output, which is an intermediate. The two differ in the one
 * place that matters, and the difference is silent if it is missed.
 *
 * `DemRaster` leaves a cell with no ground return as NaN. `DtmGrid` fills every
 * cell and records what the height came from in `coverage`: none, interpolated,
 * or measured. Reading `DtmGrid` the way `DemRaster` is read would therefore
 * find no absent cells at all, because none of them is NaN, and a hole filled
 * from a distant neighbour would route flow as confidently as surveyed ground.
 *
 * Interpolated cells are a declared choice rather than a default. Blocking them
 * fragments the surface and manufactures sinks at the edge of every gap;
 * routing over them is what a filled DTM is for. So `route` is the default and
 * the count reaches the basis, where it becomes a limitation the reader sees.
 * `block` is there for a caller that wants measured ground only.
 */
export function terrainDtmToFlowGrid(
  dtm: DtmGrid,
  scale: HorizontalScale,
  options: {
    readonly interpolated?: InterpolatedPolicy;
    readonly withheldExcluded?: boolean | null;
  } = {},
): DtmFlowGrid {
  const policy = options.interpolated ?? 'route';
  const n = dtm.cols * dtm.rows;
  const z = new Float32Array(n);
  const valid = new Uint8Array(n);

  let readable = 0;
  let interpolated = 0;
  for (let i = 0; i < n; i++) {
    const cover = dtm.coverage[i];
    if (cover === COVERAGE_NONE) continue;
    if (cover === COVERAGE_INTERPOLATED) {
      if (policy === 'block') continue;
      interpolated++;
    }
    const v = dtm.z[i];
    // A filled grid should carry no NaN, but a non-finite height here would
    // route as an elevation, so it is treated as absence rather than trusted.
    if (!Number.isFinite(v)) continue;
    z[i] = v;
    valid[i] = 1;
    readable++;
  }

  const metres = horizontalCellMetresXY(
    dtm.cellSizeM,
    scale.isGeographic,
    scale.latitudeDeg,
    scale.unitToMetres,
  );

  return {
    grid: {
      z, valid, cols: dtm.cols, rows: dtm.rows,
      cellMetresX: metres.x, cellMetresY: metres.y,
    },
    basis: simulationInputBasis({
      // `DtmGrid.coverageMode` is how much of the source the analysis walked.
      // Not `DtmGrid.coverage`, which is a per-cell provenance array under the
      // same word; reading that one here would put a Uint8Array where a mode
      // belongs. Hardcoding 'full' would be worse still, since a DTM built
      // from a resident streamed subset would then claim the whole survey.
      coverage: dtm.coverageMode,
      withheldExcluded: options.withheldExcluded ?? null,
      horizontalScaleResolved: scale.resolved,
      measuredCells: readable,
      interpolatedCells: policy === 'block' ? 0 : interpolated,
      totalCells: n,
    }),
  };
}
