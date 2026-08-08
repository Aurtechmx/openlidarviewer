/**
 * Types for `make-contour-fixture.mjs`.
 *
 * The generator is plain ESM because it runs under bare `node` with no build
 * step, but the cross-check test imports its surface definition so the DEM and
 * the closed-form contour truth cannot drift apart. Declaring the exports here
 * keeps that single definition and still typechecks.
 */

export interface ContourFixtureGrid {
  readonly ncols: number;
  readonly nrows: number;
  readonly cellsize: number;
  readonly xllcorner: number;
  readonly yllcorner: number;
  readonly nodata: number;
}

export interface ContourFixturePlane {
  readonly sx: number;
  readonly sy: number;
  readonly z0: number;
}

export declare const GRID: ContourFixtureGrid;
export declare const PLANE: ContourFixturePlane;

/** Surface elevation at any WORLD point — the analytic truth. */
export declare function analyticElevation(X: number, Y: number): number;

/** World cell-centre for an ASCII-Grid file row (0 = NORTH) and column. */
export declare function cellCentreWorld(fileRow: number, col: number): [number, number];
