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

/**
 * Closed-form aspect at a cell centre, in COMPASS DEGREES clockwise from north.
 * NaN on an exactly flat cell, where the downslope direction is undefined —
 * 0 would read as due north.
 */
export declare function analyticAspectDegrees(row: number, col: number): number;

/** Sun the hillshade reference is lit by, pinned rather than left to defaults. */
export interface SlopeFixtureSun {
  readonly azimuthDeg: number;
  readonly altitudeDeg: number;
  readonly zFactor: number;
}

export declare const SUN: SlopeFixtureSun;

/**
 * Closed-form hillshade at a cell centre on the 0–255 scale, UNROUNDED and
 * UNCLAMPED, in OUR encoding (255·h). `gdaldem hillshade` encodes the same
 * intensity as 1 + 254·h; the difference is left visible rather than divided
 * out — see `tests/hillshadeCrossCheck.test.ts`.
 *
 * Total, unlike `analyticAspectDegrees`: hillshade is defined at zero gradient,
 * where it reduces to 255·cos(zenith).
 */
export declare function analyticHillshade255(row: number, col: number): number;
