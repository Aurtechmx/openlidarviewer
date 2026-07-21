/**
 * Types for `make-slope-fixture.mjs`.
 *
 * The generator is plain ESM because it runs under bare `node` with no build
 * step, but the cross-check test imports its surface definition so the DEM and
 * the closed-form truth cannot drift apart. Declaring the exports here keeps
 * that single definition and still typechecks; copying the maths into the test
 * would give two definitions that agree only until someone edits one.
 */

export interface SlopeFixtureGrid {
  readonly ncols: number;
  readonly nrows: number;
  readonly cellsize: number;
  readonly xllcorner: number;
  readonly yllcorner: number;
  readonly nodata: number;
}

export interface SlopeFixtureSurface {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
}

export declare const GRID: SlopeFixtureGrid;
export declare const SURFACE: SlopeFixtureSurface;

/** Cell-centre offset from the grid centre, metres. `row` 0 is NORTHERNMOST. */
export declare function cellOffset(row: number, col: number): { x: number; y: number };

/** Surface height at a cell centre. */
export declare function heightAt(row: number, col: number): number;

/** Closed-form slope at a cell centre, in DEGREES. */
export declare function analyticSlopeDegrees(row: number, col: number): number;
