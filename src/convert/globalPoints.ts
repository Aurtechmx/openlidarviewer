/**
 * globalPoints.ts
 *
 * Reconstructs full-precision *global* coordinates from a `PointCloud` (whose
 * positions are stored local to an integer `origin`), and carries the
 * per-point attributes the writers need. Keeping coordinates in Float64 here
 * lets the reprojection step run in double precision and lets the LAS writer
 * pick an honest scale/offset.
 *
 * Pure data — no DOM, no three.js.
 */

import type { PointCloud } from '../model/PointCloud';

/** Global-space points plus the attributes the output writers consume. */
export interface GlobalPoints {
  readonly count: number;
  /** Global X / Y / Z, one entry per point (Float64 for precision). */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** Interleaved rgb (0–255), or undefined. */
  readonly colors?: Uint8Array;
  readonly intensity?: Uint16Array;
  readonly classification?: Uint8Array;
  readonly returnNumber?: Uint8Array;
  readonly returnCount?: Uint8Array;
  readonly pointSourceId?: Uint16Array;
  readonly gpsTime?: Float64Array;
}

/**
 * Lift a `PointCloud` into global coordinates. `global = local + origin`,
 * computed in Float64 so survey eastings/northings keep their precision.
 */
export function cloudToGlobal(cloud: PointCloud): GlobalPoints {
  const n = cloud.pointCount;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const p = cloud.positions;
  const [ox, oy, oz] = cloud.origin;
  for (let i = 0; i < n; i++) {
    x[i] = p[i * 3] + ox;
    y[i] = p[i * 3 + 1] + oy;
    z[i] = p[i * 3 + 2] + oz;
  }
  return {
    count: n,
    x,
    y,
    z,
    colors: cloud.colors,
    intensity: cloud.intensity,
    classification: cloud.classification,
    returnNumber: cloud.returnNumber,
    returnCount: cloud.returnCount,
    pointSourceId: cloud.pointSourceId,
    gpsTime: cloud.gpsTime,
  };
}

/** Axis-aligned min/max over the global coordinates. */
export function globalBounds(g: GlobalPoints): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.count; i++) {
    if (g.x[i] < min[0]) min[0] = g.x[i];
    if (g.y[i] < min[1]) min[1] = g.y[i];
    if (g.z[i] < min[2]) min[2] = g.z[i];
    if (g.x[i] > max[0]) max[0] = g.x[i];
    if (g.y[i] > max[1]) max[1] = g.y[i];
    if (g.z[i] > max[2]) max[2] = g.z[i];
  }
  if (g.count === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  return { min, max };
}
