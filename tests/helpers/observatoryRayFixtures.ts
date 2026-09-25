/**
 * observatoryRayFixtures.ts: vector helpers, a single-station builder and a
 * repeated-cell organized frame, shared by the Observatory end-to-end specs
 * that drive the real ray builder and ledger (O5 fixtures, strength, run
 * record export).
 */
import type { AcquisitionStation } from '../../src/model/AcquisitionStations';
import { CellState, NO_RECORD, tallyCellStates, type OrganizedRangeFrame } from '../../src/model/OrganizedRange';
import { clipRayToDomain, type ObservationDomain } from '../../src/observation/ledger';
import type { GriddedRayCoverage } from '../../src/observation/rays';

export type Vec3 = readonly [number, number, number];

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** rays.ts's `writeDirectionFromAngles` (upAxis 'z'), inverted: azimuth/polar (radians) that reproduce `direction` exactly under that same formula. */
export function azimuthPolarOf(direction: Vec3): { readonly azimuth: number; readonly polar: number } {
  return { azimuth: Math.atan2(direction[1], direction[0]), polar: Math.acos(direction[2]) };
}

/** A DECLARED ptx-block station at `origin` with an empty record range. */
export function station(id: string, origin: Vec3): AcquisitionStation {
  return { id, source: 'ptx-block', pose: { worldTranslation: origin, localPositionSource: 'not-applicable' }, recordRange: { start: 0, end: 0 }, originStatus: 'DECLARED' };
}

/** Rays per probe; equals OB-ST-THRESHOLDS n_min. */
export const RAYS_PER_PROBE = 5;

/**
 * A real `OrganizedRangeFrame` of `RAYS_PER_PROBE` identical grid cells, all
 * `VALID_RETURN` at `range` (a finite returned ray) or all `NO_RETURN` (a
 * no-return ray) when `range` is null: repeated cells reach `n_min` rays
 * through ONE real grid, not `n_min` separately declared facts.
 */
export function buildRepeatedRayCells(range: number | null): { readonly frame: OrganizedRangeFrame; readonly coverage: GriddedRayCoverage } {
  const width = RAYS_PER_PROBE;
  const height = 1;
  const cells = width * height;
  const isNoReturn = range === null;
  const cellState = new Uint8Array(cells).fill(isNoReturn ? CellState.NO_RETURN : CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(cells).fill(isNoReturn ? NO_RECORD : 0);
  const geometricRange = new Float32Array(cells).fill(isNoReturn ? Number.NaN : range);
  if (!isNoReturn) for (let i = 0; i < cells; i++) cellToRecord[i] = i;
  const frame: OrganizedRangeFrame = {
    id: 'probe',
    sourceKind: 'ptx-grid',
    width,
    height,
    cellState,
    cellToRecord,
    geometricRange,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
  };
  // Every cell shares one direction (azimuthStep/polarStep 0): the coverage
  // itself is filled in by each call site from its own chosen direction.
  return { frame, coverage: { azimuth0: 0, azimuthStep: 0, polar0: 0, polarStep: 0 } };
}

/**
 * F1's geometry: one station at the origin, a thin wall at x = 5..5.2 in an
 * open room, and the ray toward (5.1, 0, 1.5), inside the wall's own box and
 * well inside the declared elevation band [-30, 45] (~16.4 deg).
 * `wallEntryRange` is the real near-face intersection distance.
 */
export function f1WallRay(): {
  readonly domain: ObservationDomain;
  readonly voxelEdge: number;
  readonly wallDomain: ObservationDomain;
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly wallEntryRange: number;
} {
  const domain: ObservationDomain = { min: [-1, -6, -1], max: [16, 6, 6] };
  const wallDomain: ObservationDomain = { min: [5, -2, 0], max: [5.2, 2, 3] };
  const origin: Vec3 = [0, 0, 0];
  const direction = normalize(subtract([5.1, 0, 1.5], origin));
  const wallClip = clipRayToDomain(origin, direction, 0, Infinity, wallDomain);
  if (wallClip === null) throw new Error('test setup: the chosen direction must hit the wall');
  return { domain, voxelEdge: 0.5, wallDomain, origin, direction, wallEntryRange: wallClip.tEntry };
}
