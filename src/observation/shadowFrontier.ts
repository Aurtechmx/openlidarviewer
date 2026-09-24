/**
 * shadowFrontier.ts — `olv.observation.shadow-frontier` (docs/observatory/SPEC.md
 * §2.4, §5.4, OB-SH-01..02, phase O5).
 *
 * SPEC §2.4: "the set of `SURFACE` or `OBSERVED_EMPTY` voxels 6-adjacent to a
 * `SHADOWED`, `UNADDRESSED` or `NO_RETURN_PATH` voxel." This module walks the
 * 6-neighbourhood (±X, ±Y, ±Z in the domain grid `observationField.ts`
 * classifies over) of every `SURFACE`/`OBSERVED_EMPTY` voxel and tests each
 * neighbour's own state, keeping the three adjacency counts separate rather
 * than merged (OB-SH-02: "kept adjacency to ... separate").
 *
 * A neighbour outside the domain grid's own bounds is simply absent (no
 * wraparound, no assumed state): a frontier voxel at the domain's edge is
 * judged only on the neighbours that actually exist inside the classified
 * grid.
 *
 * Pure and DOM-free (OB-INT-01): reads only a `stateByKey` map and a grid
 * shape, no I/O, no randomness.
 */
import { packVoxelKey, unpackVoxelKey } from './ledger';
import type { ObservationState } from './types';

/**
 * OB-SH-02's declared output: the frontier voxel set (packed keys, matching
 * `ObservationLedgerRow.key` in `ledger.ts`), its estimated area at `h²` per
 * exposed face in metric units when the unit is known, and its adjacency to
 * `SHADOWED`, `UNADDRESSED` and `NO_RETURN_PATH` kept as separate counts
 * rather than merged into one figure.
 */
export interface ShadowFrontierResult {
  readonly frontierVoxelKeys: readonly number[];
  /** `h² × exposedFaceCount`, or `null` when the linear unit is unknown (OB-INV-10). */
  readonly areaSquareMetres: number | null;
  readonly adjacentToShadowed: number;
  readonly adjacentToUnaddressed: number;
  readonly adjacentToNoReturnPath: number;
}

const NEIGHBOUR_OFFSETS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const SHADOW_ADJACENT_STATES: ReadonlySet<ObservationState> = new Set(['SHADOWED', 'UNADDRESSED', 'NO_RETURN_PATH']);

/**
 * OB-SH-01/02: the shadow frontier over `stateByKey`, an aggregate field or
 * any isolated per-source field — this function reads only states, so
 * "aggregate" vs. "isolated to source s" is entirely a fact about which
 * decisions the caller put into `stateByKey`, not something this module
 * distinguishes itself.
 *
 * `voxelEdge` and `metresPerUnit` follow OB-INV-10: an area figure is
 * reported only when the linear unit is known (`metresPerUnit` non-null);
 * otherwise `areaSquareMetres` is `null` while the frontier set and the three
 * adjacency counts — none of them a metric figure — are still returned.
 */
export function computeShadowFrontier(
  stateByKey: ReadonlyMap<number, ObservationState>,
  grid: { readonly nx: number; readonly ny: number; readonly nz: number },
  voxelEdge: number,
  metresPerUnit: number | null,
): ShadowFrontierResult {
  const frontierVoxelKeys: number[] = [];
  let adjacentToShadowed = 0;
  let adjacentToUnaddressed = 0;
  let adjacentToNoReturnPath = 0;
  let exposedFaceCount = 0;

  for (const [key, state] of stateByKey) {
    if (state !== 'SURFACE' && state !== 'OBSERVED_EMPTY') continue;

    const { ix, iy, iz } = unpackVoxelKey(key, grid.nx, grid.ny);
    let touchesShadowed = false;
    let touchesUnaddressed = false;
    let touchesNoReturnPath = false;

    for (const [dx, dy, dz] of NEIGHBOUR_OFFSETS) {
      const nx2 = ix + dx;
      const ny2 = iy + dy;
      const nz2 = iz + dz;
      if (nx2 < 0 || ny2 < 0 || nz2 < 0 || nx2 >= grid.nx || ny2 >= grid.ny || nz2 >= grid.nz) continue;
      const neighbourState = stateByKey.get(packVoxelKey(nx2, ny2, nz2, grid.nx, grid.ny));
      if (neighbourState === undefined || !SHADOW_ADJACENT_STATES.has(neighbourState)) continue;

      exposedFaceCount += 1;
      if (neighbourState === 'SHADOWED') touchesShadowed = true;
      else if (neighbourState === 'UNADDRESSED') touchesUnaddressed = true;
      else touchesNoReturnPath = true;
    }

    if (touchesShadowed || touchesUnaddressed || touchesNoReturnPath) {
      frontierVoxelKeys.push(key);
      if (touchesShadowed) adjacentToShadowed += 1;
      if (touchesUnaddressed) adjacentToUnaddressed += 1;
      if (touchesNoReturnPath) adjacentToNoReturnPath += 1;
    }
  }

  const areaSquareMetres = metresPerUnit === null ? null : exposedFaceCount * (voxelEdge * metresPerUnit) ** 2;

  return { frontierVoxelKeys, areaSquareMetres, adjacentToShadowed, adjacentToUnaddressed, adjacentToNoReturnPath };
}
