/**
 * gatherUpAxis.ts — the vertical axis of the terrain gather.
 *
 * Terrain reads a position buffer as X and Y horizontal, Z elevation, so the
 * gather settles the buffer's up axis once, before anything reads it. The rule
 * is the per-layer one every consumer shares (`src/geo/frame/layerUpFrame.ts`;
 * measurement, the converter and navigation read it too): metadata decides the
 * axes whenever it can, and the scan's shape decides nothing for georeferenced
 * data.
 *
 * - Survey formats and COPC/EPT streams are Z-up by specification.
 * - A PLY or OBJ under an established horizontal CRS is taken to store easting,
 *   northing and height in X, Y and Z. It is never rotated: a surveyed facade
 *   can look like a Y-up model, and rotating it would analyse the wall as the
 *   ground.
 * - A glTF or GLB under a CRS is declined. glTF is Y-up by specification, so
 *   its Y is a height and cannot be read as a northing.
 * - Only a mesh with no CRS has its up axis detected from the point layout. A
 *   Y-up reading is rotated into Z-up, and the runner states that it was.
 *
 * Pure: no DOM, no three.js.
 */

import type { CrsInfo } from '../io/crs';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { isZUpFormat, sceneUpAxisPolicy, type SourceFormat } from '../io/sniffFormat';
import { gltfUnderCrsAxisReason, hasHorizontalCrs, resolveLayerUpFrame } from '../geo/frame/layerUpFrame';
import { classifyScanShape } from './scanShape';
import { yUpToCanonicalZUp } from './canonicalFrame';

/** One static cloud in the gather: its format and the CRS the app resolved for it. */
export interface TerrainGatherSource {
  readonly format: SourceFormat;
  /** The resolved CRS (override applied) when the app has one, else the declared one. */
  readonly crs: CrsInfo | ResolvedCrs | null | undefined;
}

/** What settled the gather's up axis. */
export type TerrainUpAxisBasis = 'specification' | 'crs' | 'detected';

export type TerrainGatherFrame =
  | { readonly ok: true; readonly up: 'z' | 'y'; readonly basis: TerrainUpAxisBasis }
  | { readonly ok: false; readonly reason: string };

export { hasHorizontalCrs };

/** The decline for a glTF or GLB source under a CRS. */
export function gltfUnderCrsReason(label: string): string {
  return `Terrain analysis did not run. ${gltfUnderCrsAxisReason(label)}`;
}

/** The decline for a local mesh that reads as Y-up beside Z-up layers. */
export const MIXED_FRAME_REASON =
  'Terrain analysis did not run. A mesh layer with no coordinate system reads as Y-up from its point layout, ' +
  'and the other visible layers are Z-up, so together they describe no single surface. Hide or lock one side, then run.';

/**
 * Settle the up axis of a gathered sample and normalise it to Z-up in place.
 * `positions` is the gather's own strided copy; it is rotated only when a mesh
 * with no CRS reads as Y-up. Returns null for an empty gather.
 */
export function settleTerrainGatherFrame(
  sources: ReadonlyArray<TerrainGatherSource>,
  hasStreaming: boolean,
  positions: Float32Array,
): TerrainGatherFrame | null {
  const policy = sceneUpAxisPolicy(sources.map((s) => s.format), hasStreaming);
  if (policy === null) return null;
  if (policy.kind === 'z') return { ok: true, up: 'z', basis: 'specification' };
  // A mesh under a CRS: its axes are the CRS's, never its shape's.
  let hasZ = policy.hasSpecZ;
  let local = false;
  // Each source's frame comes from the shared per-layer rule
  // (`geo/frame/layerUpFrame.ts`); only meshes with no CRS are left undecided.
  for (const s of sources) {
    if (isZUpFormat(s.format)) continue;
    if (!hasHorizontalCrs(s.crs)) {
      local = true;
      continue;
    }
    const f = resolveLayerUpFrame({ format: s.format, crs: s.crs });
    if (!f.ok) return { ok: false, reason: `Terrain analysis did not run. ${f.reason}` };
    hasZ = true;
  }
  if (!local) return { ok: true, up: 'z', basis: 'crs' };
  // Only meshes with no CRS remain undecided, and only their points can say.
  // (`resolveLayerUpFrame` with `detected` set gives the same answer.)
  const up = classifyScanShape(positions).up === 'y' ? 'y' : 'z';
  // A Y-up reading beside Z-up layers is two different frames; their union
  // describes no surface.
  if (up === 'y' && hasZ) return { ok: false, reason: MIXED_FRAME_REASON };
  if (up === 'y') yUpToCanonicalZUp(positions);
  return { ok: true, up, basis: 'detected' };
}

/**
 * The line the Analyse panel shows when the up axis came from the point layout
 * rather than from a specification or a CRS; null otherwise.
 */
export function detectedUpAxisNote(basis: TerrainUpAxisBasis | undefined, up: 'z' | 'y' | undefined): string | null {
  if (basis !== 'detected') return null;
  return up === 'y'
    ? 'This mesh has no coordinate system, so its up axis was read from the point layout: it reads as Y-up and was rotated to Z-up, (x, y, z) to (x, -z, y), for this analysis. Assign a CRS if its X, Y and Z are easting, northing and height.'
    : 'This mesh has no coordinate system, so its up axis was read from the point layout: it reads as Z-up and was analysed as stored.';
}
