/**
 * terrainAccessOverlayGeometry.ts — pure buffers for drawing a Terrain Access
 * run in the scene. Mirrors `flowOverlayGeometry.ts`'s placement rule exactly
 * (same `place()`, same Z-up/Y-up pairing keyed off the scan's raw scene
 * up-axis) so a Terrain Access overlay can never disagree with a flow or
 * contour overlay drawn over the same terrain.
 *
 * Two products: the traversability map (every eligible cell, flat-shaded by
 * its `MapCellState` bucket) and the found route (a line strip). Colour is a
 * fixed, declared palette per bucket — never a continuous ramp implying a
 * validated score, matching the "illustrative buckets" caution
 * `traversabilityCost.ts` documents for `MAP_COST_BUCKETS`.
 *
 * PRESENTATION, NOT SCIENCE. Every function here only uploads buffers a pure
 * builder already computed; it never reads a run's arrays to decide anything.
 *
 * Pure: no DOM, no three.js.
 */

import type { TraversabilityMapCell } from '../simulation/terrainAccess/traversabilityCost';
import type { TerrainAccessGrid } from '../simulation/terrainAccess/terrainAccessTypes';

export type TerrainAccessOverlayVerticalAxis = 'z' | 'y';

/** The frame + grid geometry every buffer builder places cells into. */
export interface TerrainAccessOverlayFrame {
  readonly verticalAxis: TerrainAccessOverlayVerticalAxis;
  readonly negateNorthing: boolean;
  /** DTM raster origin, horizontal axis 1 (east), in the DTM's source unit. */
  readonly originH1: number;
  /** DTM raster origin, horizontal axis 2 (north), in the DTM's source unit. */
  readonly originH2: number;
  /** Cell length in the DTM's source unit. */
  readonly cellSizeM: number;
}

export function terrainAccessOverlayFrame(
  sceneUpAxis: TerrainAccessOverlayVerticalAxis | null | undefined,
  originH1: number,
  originH2: number,
  cellSizeM: number,
): TerrainAccessOverlayFrame {
  const axis = sceneUpAxis ?? 'z';
  return { verticalAxis: axis, negateNorthing: axis === 'y', originH1, originH2, cellSizeM };
}

function place(
  frame: TerrainAccessOverlayFrame,
  col: number,
  row: number,
  elevation: number,
  out: Float32Array,
  o: number,
): void {
  const x = frame.originH1 + col * frame.cellSizeM;
  const north = frame.originH2 + row * frame.cellSizeM;
  const n = frame.negateNorthing ? -north : north;
  if (frame.verticalAxis === 'y') {
    out[o] = x; out[o + 1] = elevation; out[o + 2] = n;
  } else {
    out[o] = x; out[o + 1] = n; out[o + 2] = elevation;
  }
}

/** Declared RGB (0-255) per bucket — colourblind-distinguishable, no gradient. */
export const MAP_STATE_RGB: Readonly<Record<TraversabilityMapCell['state'], readonly [number, number, number]>> = Object.freeze({
  blocked: [110, 40, 40],
  unknown: [40, 44, 54],
  'low-cost': [58, 140, 84],
  'moderate-cost': [186, 168, 62],
  'high-cost': [196, 92, 48],
});

export interface TerrainAccessOverlayMeshBuffers {
  readonly verts: Float32Array;
  readonly colors: Float32Array;
  readonly cellsDrawn: number;
}

export interface TerrainAccessOverlayLineBuffers {
  readonly verts: Float32Array;
  readonly segments: number;
}

const QUAD_OFFSETS: readonly (readonly [number, number])[] = [
  [-0.5, -0.5], [0.5, -0.5], [0.5, 0.5],
  [-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5],
];

/** The traversability map overlay: every readable cell, coloured by its declared bucket. */
export function buildTerrainAccessMapBuffers(
  grid: TerrainAccessGrid,
  map: readonly TraversabilityMapCell[],
  frame: TerrainAccessOverlayFrame,
): TerrainAccessOverlayMeshBuffers {
  const { cols, rows } = grid;
  const n = cols * rows;
  let drawn = 0;
  for (let i = 0; i < n; i++) if (grid.valid[i] === 1) drawn++;

  const positions = new Float32Array(drawn * QUAD_OFFSETS.length * 3);
  const colors = new Float32Array(drawn * QUAD_OFFSETS.length * 3);
  let p = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (grid.valid[i] !== 1) continue;
      const elev = grid.z[i];
      const [r255, g255, b255] = MAP_STATE_RGB[map[i].state];
      const r = r255 / 255, g = g255 / 255, b = b255 / 255;
      for (const [dc, dr] of QUAD_OFFSETS) {
        place(frame, col + dc, row + dr, elev, positions, p);
        colors[p] = r; colors[p + 1] = g; colors[p + 2] = b;
        p += 3;
      }
    }
  }

  return { verts: positions, colors, cellsDrawn: drawn };
}

/** The found route: a line segment between each consecutive pair of path cells. */
export function buildTerrainAccessRouteBuffers(
  grid: TerrainAccessGrid,
  path: readonly number[],
  frame: TerrainAccessOverlayFrame,
): TerrainAccessOverlayLineBuffers {
  const segments = Math.max(0, path.length - 1);
  const positions = new Float32Array(segments * 6);
  let p = 0;
  for (let k = 0; k < segments; k++) {
    const a = path[k];
    const b = path[k + 1];
    const ac = a % grid.cols, ar = Math.floor(a / grid.cols);
    const bc = b % grid.cols, br = Math.floor(b / grid.cols);
    place(frame, ac, ar, grid.z[a], positions, p); p += 3;
    place(frame, bc, br, grid.z[b], positions, p); p += 3;
  }
  return { verts: positions, segments };
}
