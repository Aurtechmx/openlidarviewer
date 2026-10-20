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
 * - A glTF or GLB with no CRS is Y-up by specification and is rotated into
 *   Z-up. Its point layout is not consulted: a wall stored Y-up is a wall.
 * - Only a PLY or OBJ with no CRS has its up axis read from its own points. A
 *   Y-up reading is rotated into Z-up, and the runner states that it was.
 *
 * Each layer's frame is settled on its own before the layers are combined.
 * Layers whose up axes differ describe no single surface, and the gather
 * declines rather than reading one axis from their union.
 *
 * Pure: no DOM, no three.js.
 */

import type { CrsInfo } from '../io/crs';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { isZUpFormat, sceneUpAxisPolicy, type SourceFormat } from '../io/sniffFormat';
import { gltfUnderCrsAxisReason, hasHorizontalCrs, isYUpBySpec, resolveLayerUpFrame } from '../geo/frame/layerUpFrame';
import { classifyScanShape } from './scanShape';
import { yUpToCanonicalZUp } from './canonicalFrame';

/** One static cloud in the gather: its format and the CRS the app resolved for it. */
export interface TerrainGatherSource {
  readonly format: SourceFormat;
  /** The resolved CRS (override applied) when the app has one, else the declared one. */
  readonly crs: CrsInfo | ResolvedCrs | null | undefined;
  /**
   * The layer's own points. Read only for a PLY or OBJ with no CRS, whose up
   * axis comes from its point layout; when absent, the gathered sample is read.
   */
  readonly layerPoints?: Float32Array | null;
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

/** The decline for a glTF or GLB layer, Y-up by specification, beside Z-up layers. */
export const MIXED_GLTF_FRAME_REASON =
  'Terrain analysis did not run. A glTF or GLB layer is Y-up by specification, and the other visible layers are Z-up, ' +
  'so together they describe no single surface. Hide or lock one side, then run.';

/**
 * Settle the up axis of a gathered sample and normalise it to Z-up in place.
 * `positions` is the gather's own strided copy; it is rotated only when every
 * contributing layer is Y-up. Returns null for an empty gather.
 */
export function settleTerrainGatherFrame(
  sources: ReadonlyArray<TerrainGatherSource>,
  hasStreaming: boolean,
  positions: Float32Array,
): TerrainGatherFrame | null {
  const policy = sceneUpAxisPolicy(sources.map((s) => s.format), hasStreaming);
  if (policy === null) return null;
  if (policy.kind === 'z') return { ok: true, up: 'z', basis: 'specification' };
  // Settle each layer through the shared per-layer rule
  // (`geo/frame/layerUpFrame.ts`), then compare. Streams are Z-up by
  // specification.
  let hasZ = hasStreaming;
  let yBySpec = false;
  let yDetected = false;
  let anyDetected = false;
  let anyCrs = false;
  for (const s of sources) {
    const local = !isZUpFormat(s.format) && !hasHorizontalCrs(s.crs);
    // Only a PLY or OBJ with no CRS has no axis from its format or its CRS;
    // its own points decide it.
    const own = s.layerPoints;
    const detected = local && !isYUpBySpec(s.format)
      ? (classifyScanShape(own && own.length > 0 ? own : positions).up === 'y' ? 'y' : 'z')
      : undefined;
    const f = resolveLayerUpFrame({ format: s.format, crs: s.crs, ...(detected ? { detected } : {}) });
    if (!f.ok) return { ok: false, reason: `Terrain analysis did not run. ${f.reason}` };
    if (f.basis === 'detected') anyDetected = true;
    if (f.basis === 'crs') anyCrs = true;
    if (f.axis === 'z') hasZ = true;
    else if (f.basis === 'detected') yDetected = true;
    else yBySpec = true;
  }
  const hasY = yBySpec || yDetected;
  // Layers with different up axes are two frames; their union describes no surface.
  if (hasY && hasZ) return { ok: false, reason: yBySpec ? MIXED_GLTF_FRAME_REASON : MIXED_FRAME_REASON };
  const basis: TerrainUpAxisBasis = anyDetected ? 'detected' : anyCrs ? 'crs' : 'specification';
  if (hasY) {
    yUpToCanonicalZUp(positions);
    return { ok: true, up: 'y', basis };
  }
  return { ok: true, up: 'z', basis };
}

/**
 * The line the Analyse panel shows when the gathered points were rotated or
 * their up axis was read from the point layout; null otherwise.
 */
export function gatherUpAxisNote(basis: TerrainUpAxisBasis | undefined, up: 'z' | 'y' | undefined): string | null {
  if (basis === 'specification' && up === 'y') {
    return 'glTF is Y-up by specification, so this mesh was rotated to Z-up, (x, y, z) to (x, -z, y), for this analysis. Its stored coordinates are unchanged.';
  }
  if (basis !== 'detected') return null;
  return up === 'y'
    ? 'This mesh has no coordinate system, so its up axis was read from the point layout: it reads as Y-up and was rotated to Z-up, (x, y, z) to (x, -z, y), for this analysis. Assign a CRS if its X, Y and Z are easting, northing and height.'
    : 'This mesh has no coordinate system, so its up axis was read from the point layout: it reads as Z-up and was analysed as stored.';
}
