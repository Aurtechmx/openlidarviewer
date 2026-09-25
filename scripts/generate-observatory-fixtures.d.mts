/**
 * Types for the importable surface of `generate-observatory-fixtures.mjs`.
 *
 * The generator is plain ESM (no build step, runs under bare `node`), but
 * `tests/observatoryFixtureF8.test.ts` calls the same pure functions the CLI
 * writes to disk from, so the committed fixture and what the generator
 * actually returns cannot drift apart unnoticed. Only the two pure exports
 * are declared; the CLI body is guarded behind `isCliEntry` and has no types.
 */

export interface ObservatoryF1Scene {
  readonly id: 'F1';
  readonly description: string;
  readonly station: { readonly id: string; readonly origin: readonly [number, number, number]; readonly status: 'DECLARED' };
  readonly angularExtent: { readonly azimuthDeg: readonly [number, number]; readonly elevationDeg: readonly [number, number] };
  readonly wall: { readonly minCorner: readonly [number, number, number]; readonly maxCorner: readonly [number, number, number] };
  readonly room: { readonly minCorner: readonly [number, number, number]; readonly maxCorner: readonly [number, number, number] };
  readonly domain: { readonly minCorner: readonly [number, number, number]; readonly maxCorner: readonly [number, number, number] };
  readonly voxelEdge: number;
}

export interface ObservatoryAabb {
  readonly minCorner: readonly [number, number, number];
  readonly maxCorner: readonly [number, number, number];
}

export interface ObservatoryF8Case {
  readonly id: string;
  readonly description: string;
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly tMax: number;
}

export interface ObservatoryF8Cases {
  readonly domain: ObservatoryAabb;
  readonly voxelEdge: number;
  readonly tieRule: string;
  readonly cases: readonly ObservatoryF8Case[];
}

export interface ObservatoryGriddedStation {
  readonly id: string;
  readonly origin: readonly [number, number, number];
}

export interface ObservatoryGriddedCoverage {
  readonly azimuth0: number;
  readonly azimuthStep: number;
  readonly polar0: number;
  readonly polarStep: number;
}

export interface ObservatoryF5Scene {
  readonly id: 'F5';
  readonly description: string;
  readonly sourceKind: 'ptx-grid';
  readonly width: number;
  readonly height: number;
  readonly station: ObservatoryGriddedStation;
  readonly coverage: ObservatoryGriddedCoverage;
  readonly noReturnCells: readonly (readonly [number, number])[];
}

export interface ObservatoryF6Scene {
  readonly id: 'F6';
  readonly description: string;
  readonly sourceKind: 'e57-structured';
  readonly width: number;
  readonly height: number;
  readonly station: ObservatoryGriddedStation;
  readonly coverage: ObservatoryGriddedCoverage;
  readonly stride: number;
}

export interface ObservatoryF16SceneReturn {
  readonly returnIndex: number;
  readonly range: number;
}

export interface ObservatoryF16SceneCell {
  readonly row: number;
  readonly column: number;
  readonly returns: readonly ObservatoryF16SceneReturn[];
}

export interface ObservatoryF16Scene {
  readonly id: 'F16';
  readonly description: string;
  readonly sourceKind: 'e57-structured';
  readonly width: number;
  readonly height: number;
  readonly station: ObservatoryGriddedStation;
  readonly coverage: ObservatoryGriddedCoverage;
  readonly cells: readonly ObservatoryF16SceneCell[];
}

export interface ObservatoryStationWithExtent {
  readonly id: string;
  readonly origin: readonly [number, number, number];
  readonly status: 'DECLARED';
  readonly angularExtent: { readonly azimuthDeg: readonly [number, number]; readonly elevationDeg: readonly [number, number] };
}

export interface ObservatoryF2Scene extends Omit<ObservatoryF1Scene, 'id' | 'station'> {
  readonly id: 'F2';
  readonly stations: readonly [ObservatoryF1Scene['station'], ObservatoryStationWithExtent];
}

export interface ObservatoryF3Scene {
  readonly id: 'F3';
  readonly description: string;
  readonly stationA: ObservatoryStationWithExtent;
  readonly stationB: ObservatoryStationWithExtent;
  readonly box: ObservatoryAabb;
  readonly domain: ObservatoryAabb;
  readonly voxelEdge: number;
}

export interface ObservatoryF7Scene {
  readonly id: 'F7';
  readonly description: string;
  readonly station: ObservatoryStationWithExtent & { readonly maxRange: number };
  readonly pocket: ObservatoryAabb;
  readonly domain: ObservatoryAabb;
  readonly voxelEdge: number;
}

export function buildF1Scene(): ObservatoryF1Scene;
export function buildF8Cases(): ObservatoryF8Cases;
export function buildF5Scene(): ObservatoryF5Scene;
export function buildF6Scene(): ObservatoryF6Scene;
export function buildF16Scene(): ObservatoryF16Scene;
export function buildF2Scene(): ObservatoryF2Scene;
export function buildF3Scene(): ObservatoryF3Scene;
export function buildF7Scene(): ObservatoryF7Scene;
