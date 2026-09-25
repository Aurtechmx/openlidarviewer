/**
 * observatoryPlanningFixtures.ts: the F11 declared field expanded into a
 * `PlanningField`, and the synthetic wall-and-ground cloud the O10 end-to-end
 * specs run through `runObservatoryOverCloud`.
 */
import { buildF11Scene, type ObservatoryF11Scene } from '../../scripts/generate-observatory-fixtures.mjs';
import { domainGrid, packVoxelKey, type ObservationDomain, type ObservationLedgerRow } from '../../src/observation/ledger';
import type { PlanningField } from '../../src/observation/coverageGain';
import type { ObservationState } from '../../src/observation/types';
import type { ObservatoryCloudInput } from '../../src/app/observatoryFromCloud';
import type { AcquisitionStation } from '../../src/model/AcquisitionStations';

export type Vec3 = readonly [number, number, number];

/** F11's regions expanded over every voxel centre, first match wins, the same rule `coverage_gain.py` applies. */
export function f11PlanningField(scene: ObservatoryF11Scene = buildF11Scene()): PlanningField {
  const domain: ObservationDomain = { min: scene.domain.minCorner, max: scene.domain.maxCorner };
  const h = scene.voxelEdge;
  const grid = domainGrid(domain, h);
  const stateByKey = new Map<number, ObservationState>();
  const rowByKey = new Map<number, Pick<ObservationLedgerRow, 'counters' | 'perSource'>>();
  const normalByKey = new Map<number, Vec3>();
  for (let iz = 0; iz < grid.nz; iz++) {
    for (let iy = 0; iy < grid.ny; iy++) {
      for (let ix = 0; ix < grid.nx; ix++) {
        const c = [domain.min[0] + (ix + 0.5) * h, domain.min[1] + (iy + 0.5) * h, domain.min[2] + (iz + 0.5) * h];
        const key = packVoxelKey(ix, iy, iz, grid.nx, grid.ny);
        let state = scene.defaultState as ObservationState;
        for (const region of scene.regions) {
          const inside = [0, 1, 2].every((a) => region.minCorner[a]! <= c[a]! && c[a]! < region.maxCorner[a]!);
          if (!inside) continue;
          state = region.state as ObservationState;
          if (region.rows) {
            const { sources, hit, pass } = region.rows;
            rowByKey.set(key, {
              counters: { hit, pass, behind: 0, noReturn: 0, saturated: false },
              perSource: Array.from({ length: sources }, (_, sourceIndex) => ({ sourceIndex, hit, pass, behind: 0, noReturn: 0, saturated: false, notDecoded: false })),
            });
          }
          if (region.normal) normalByKey.set(key, region.normal);
          break;
        }
        stateByKey.set(key, state);
      }
    }
  }
  return { domain, voxelEdge: h, grid, stateByKey, rowByKey, normalByKey };
}

function segmentHitsBox(a: Vec3, b: Vec3, min: Vec3, max: Vec3): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = b[k]! - a[k]!;
    if (d === 0) {
      if (a[k]! < min[k]! || a[k]! > max[k]!) return false;
      continue;
    }
    let ta = (min[k]! - a[k]!) / d;
    let tb = (max[k]! - a[k]!) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return t0 < 1 - 1e-9;
}

export const E2E_STATION_ORIGIN: Vec3 = [0, 0, 1.5];
export const E2E_WALL = { min: [5, -2, 0] as Vec3, max: [5.2, 2, 3] as Vec3 };

/**
 * F1's wall standing on open ground, as station 1 at (0, 0, 1.5) would have
 * recorded it: ground points every 0.1 over x ∈ [-1, 12], y ∈ [-5, 5] at
 * z = 0, minus every point the wall hides from the station, plus the wall's
 * near face. `bounds()` starts the domain at z = −0.49 so the ground sits
 * just under the top of its voxel layer: a grazing ray then dips into that
 * layer only in the last few centimetres before its return, and the ground
 * voxels read `SURFACE` rather than `PARTIAL`.
 */
export function wallAndGroundCloud(originStatus: string = 'DECLARED'): ObservatoryCloudInput {
  const pts: number[] = [];
  for (let xi = -10; xi <= 120; xi++) {
    for (let yi = -50; yi <= 50; yi++) {
      const p: Vec3 = [xi / 10, yi / 10, 0];
      if (segmentHitsBox(E2E_STATION_ORIGIN, p, E2E_WALL.min, E2E_WALL.max)) continue;
      pts.push(p[0], p[1], p[2]);
    }
  }
  for (let yi = -20; yi <= 20; yi++) {
    for (let zi = 0; zi <= 30; zi++) pts.push(5, yi / 10, zi / 10);
  }
  const station = {
    id: 'station-1',
    source: 'ptx-block',
    pose: { worldTranslation: E2E_STATION_ORIGIN, localPositionSource: 'not-applicable' },
    recordRange: { start: 0, end: pts.length / 3 },
    originStatus,
  } as unknown as AcquisitionStation;
  return {
    positions: Float32Array.from(pts),
    sourceOrigin: [0, 0, 0],
    acquisitionStations: { stations: [station] } as never,
    bounds: () => ({ min: [-1, -5, -0.49], max: [12, 5, 3.51] }),
  };
}
