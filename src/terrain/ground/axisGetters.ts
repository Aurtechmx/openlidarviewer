/**
 * axisGetters.ts
 *
 * Single source for projecting a {@link TerrainPoint} onto the two horizontal
 * axes (H1/H2) and the vertical axis (V), given which source-frame axis is
 * "up". Several pipeline stages (ground filter, DTM rasteriser, DSM builder,
 * hold-out validation) need this identical convention; centralising it keeps
 * them from drifting apart.
 */

import type { TerrainPoint } from '../TerrainContracts';
import type { VerticalAxis } from './groundFilter';

export interface AxisGetters {
  readonly getH1: (p: TerrainPoint) => number;
  readonly getH2: (p: TerrainPoint) => number;
  readonly getV: (p: TerrainPoint) => number;
}

/** Horizontal/vertical accessors for the given vertical axis ('z' default). */
export function axisGetters(vertical: VerticalAxis): AxisGetters {
  return {
    getH1: (p) => p.x,
    getH2: vertical === 'y' ? (p) => p.z : (p) => p.y,
    getV: vertical === 'y' ? (p) => p.y : (p) => p.z,
  };
}
