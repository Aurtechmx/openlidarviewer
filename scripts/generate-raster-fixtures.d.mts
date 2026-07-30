/**
 * Types for `generate-raster-fixtures.mjs`.
 *
 * The generator is plain ESM because it runs under bare `node` with no build
 * step, but `tests/rasterAgreementMatrix.test.ts` imports its surface
 * definitions so the written DEMs and the closed-form truth cannot drift apart.
 * Declaring the exports here keeps that single definition and still typechecks;
 * copying the maths into the test would give two definitions that agree only
 * until someone edits one. Same arrangement as `make-slope-fixture.d.mts`.
 */

export type SurfaceKind = 'constant' | 'plane' | 'quadratic' | 'absridge' | 'step';
export type NodataPattern = 'none' | 'island' | 'scatter' | 'corridor';

export interface FixtureSurface {
  readonly kind: SurfaceKind;
  /** Coefficients; which keys are present depends on `kind`. */
  readonly params: Readonly<Record<string, number>>;
}

export interface FixtureSpec {
  readonly id: string;
  /** Fixture family label used in the reported matrix. */
  readonly family: string;
  readonly note: string;
  readonly cols: number;
  readonly rows: number;
  /** Cell size in the grid's own horizontal unit (metres, or degrees when geographic). */
  readonly cellsize: number;
  readonly crs: 'projected' | 'geographic';
  readonly xll: number;
  readonly yll: number;
  readonly surface: FixtureSurface;
  readonly nodata: NodataPattern;
  /** gdaldem runs performed for this fixture. */
  readonly products: readonly string[];
}

export interface FixtureSun {
  readonly id: string;
  readonly azimuthDeg: number;
  readonly altitudeDeg: number;
  readonly zFactor: number;
}

export declare const MATRIX_DIR: string;
export declare const FIXTURE_DIR: string;
export declare const NODATA: number;
export declare const SUNS: readonly FixtureSun[];
export declare const ASPECT_MIN_SLOPE_DEG: number;
export declare const GEO_METRES_PER_DEG_LAT: number;
export declare const GEO_METRES_PER_DEG_LON: number;
export declare const GEO_CENTRE_LATITUDE_DEG: number;
export declare const FIXTURES: readonly FixtureSpec[];

/** Metres spanned by one cell along each axis. Unequal only on a geographic grid. */
export declare function cellMetres(spec: FixtureSpec): { x: number; y: number };

/** Cell-centre offset from the grid centre in METRES. `row` 0 is NORTHERNMOST. */
export declare function cellOffsetMetres(spec: FixtureSpec, row: number, col: number): { x: number; y: number };

/** True where the fixture's nodata pattern masks this cell out. */
export declare function isNodata(spec: FixtureSpec, row: number, col: number): boolean;

/** Surface height at a cell centre, NaN on a nodata cell. */
export declare function heightAt(spec: FixtureSpec, row: number, col: number): number;

/** Closed-form gradient in metres per metre, in the (east, north) frame. */
export declare function analyticGradient(spec: FixtureSpec, row: number, col: number): { dzdx: number; dzdy: number };

/** Closed-form slope in DEGREES. */
export declare function analyticSlopeDegrees(spec: FixtureSpec, row: number, col: number): number;

/** Closed-form aspect in COMPASS DEGREES clockwise from north; NaN at zero gradient. */
export declare function analyticAspectDegrees(spec: FixtureSpec, row: number, col: number): number;

/** True where a 3x3 window straddles a kink, so no 3x3 estimator matches the closed form. */
export declare function straddlesKink(spec: FixtureSpec, row: number, col: number): boolean;

/** All nine cells of the Horn window are in-grid and carry data. */
export declare function windowFullyValid(spec: FixtureSpec, row: number, col: number): boolean;

/** Centre carries data but at least one neighbour does not: the nodata halo. */
export declare function isHaloCell(spec: FixtureSpec, row: number, col: number): boolean;
