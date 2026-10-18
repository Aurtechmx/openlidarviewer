/**
 * layerUpRegistry.ts — the resolved up axis of a loaded cloud, for display.
 *
 * Height colouring, the elevation scale, the elevation filter and the colour
 * legend index a cloud's positions by its up component. They used to pick it
 * from the source format, so a PLY under a projected CRS (X, Y, Z = easting,
 * northing, height) was coloured and labelled by northing. The running app
 * registers the per-layer resolver (`app/layerUpFrames.ts`, the rule
 * measurement, terrain, conversion and navigation share); with none registered
 * (a test, a detached renderer) the format rule applies, as before.
 */

import type { PointCloud } from '../model/PointCloud';
import { isZUpFormat } from '../io/sniffFormat';

type CloudUpResolver = (cloud: PointCloud) => readonly [number, number, number] | null;

let resolver: CloudUpResolver | null = null;

/** Register (or clear) the app's per-layer up resolver. */
export function setCloudUpResolver(next: CloudUpResolver | null): void {
  resolver = next;
}

/** The component each cloud was last coloured or scaled by, so a moved frame can be found. */
const lastUsed = new WeakMap<PointCloud, 1 | 2>();

function resolveIndex(cloud: PointCloud): 1 | 2 {
  const up = resolver?.(cloud) ?? null;
  if (up) return up[2] === 1 ? 2 : 1;
  return isZUpFormat(cloud.sourceFormat) ? 2 : 1;
}

/** Which interleaved component of `cloud` is up: 2 (Z) or 1 (Y). */
export function cloudUpAxisIndex(cloud: PointCloud): 1 | 2 {
  const i = resolveIndex(cloud);
  lastUsed.set(cloud, i);
  return i;
}

/**
 * Whether any of `clouds` now resolves to a different up component than the
 * one it was last coloured or scaled by (a CRS assigned, replaced or cleared),
 * so its colours and the legend must be rebuilt.
 */
export function cloudUpAxisMoved(clouds: Iterable<PointCloud | undefined>): boolean {
  for (const c of clouds) {
    if (!c) continue;
    const was = lastUsed.get(c);
    if (was !== undefined && was !== resolveIndex(c)) return true;
  }
  return false;
}
