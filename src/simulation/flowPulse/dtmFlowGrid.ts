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
import type { FlowGrid } from './flowTypes';

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
