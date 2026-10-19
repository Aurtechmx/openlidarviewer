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
 * Which component of `cloud` is up right now, without recording it as the one
 * the cloud was coloured by. For a reader that is not a colouring pass (an
 * acquisition-coverage fit), so it cannot hide a move from {@link cloudUpAxisMoved}.
 */
export function peekCloudUpAxisIndex(cloud: PointCloud): 1 | 2 {
  return resolveIndex(cloud);
}

/**
 * Whether any of `clouds` now resolves to a different up component than the
 * one it was last coloured or scaled by (a CRS assigned, replaced or cleared),
 * so its colours and the legend must be rebuilt.
 */
export function cloudUpAxisMoved(clouds: Iterable<PointCloud | undefined>): boolean {
  let moved = false;
  for (const c of clouds) {
    if (!c) continue;
    const was = lastUsed.get(c);
    if (was === undefined) continue;
    const now = resolveIndex(c);
    if (was === now) continue;
    // A move is reported once. A cloud shown in an RGB or intensity mode is not
    // coloured by height, so no colouring pass would record its new axis, and it
    // would otherwise report a move on every later call.
    lastUsed.set(c, now);
    moved = true;
  }
  return moved;
}
