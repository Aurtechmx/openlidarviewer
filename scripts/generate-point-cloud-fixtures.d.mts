/**
 * Types for `generate-point-cloud-fixtures.mjs`.
 *
 * The generator is plain ESM because it runs under bare `node` with no build
 * step, but `tests/groundFilterPdalAgreement.test.ts` imports its fixture list
 * and its parsers so the committed bytes and the test's reading of them cannot
 * drift apart. Declaring the exports here keeps the single definition and still
 * typechecks. Same arrangement as `generate-raster-fixtures.d.mts`.
 */

export type PointCloudSurface = 'plane' | 'rolling' | 'ridge';
export type PointCloudRole = 'classification' | 'bare-earth';
export type PointCloudLayout = 'scattered' | 'cell-centred';

export interface PointCloudFixtureSpec {
  readonly id: string;
  /** The identifier this fixture carries in validation/datasets/dataset-register.yaml. */
  readonly datasetId: string;
  readonly surface: PointCloudSurface;
  readonly role: PointCloudRole;
  readonly layout: PointCloudLayout;
  readonly objects: boolean;
  readonly gap: boolean;
  readonly blunders: boolean;
  readonly seed: number;
}

export interface FixturePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BuildingSpec {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly d: number;
  readonly h: number;
}

export declare const PIPELINE_DIR: string;
export declare const FIXTURE_DIR: string;
export declare const COORD_DECIMALS: number;
export declare const GROUND_DENSITY: number;
export declare const EXTENT_M: number;
export declare const DTM_CELL_M: number;
export declare const BUILDINGS: readonly BuildingSpec[];
export declare const GAP_RECT: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
export declare const BLUNDER_COUNT: number;
export declare const BLUNDER_DEPTH_M: number;
export declare const FIXTURES: readonly PointCloudFixtureSpec[];
export declare const SURFACES: Readonly<Record<PointCloudSurface, (x: number, y: number) => number>>;

export declare function lcg(seed: number): () => number;
export declare function buildFixture(spec: PointCloudFixtureSpec): {
  points: FixturePoint[];
  truth: number[];
};
export declare function fixtureCsv(points: readonly FixturePoint[]): string;
export declare function truthText(truth: readonly number[]): string;
export declare function parseFixtureCsv(text: string): FixturePoint[];
export declare function parseTruth(text: string): Uint8Array;
export declare function readFixture(id: string): { points: FixturePoint[]; truth: Uint8Array };
export declare function sha256Of(buf: string | Uint8Array): string;
export declare function fixtureCsvPath(id: string): string;
export declare function fixtureTruthPath(id: string): string;
