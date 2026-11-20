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

/** How every decline below opens: the gather declines on behalf of terrain analysis. */
export const TERRAIN_DECLINE_LEAD = 'Terrain analysis did not run. ';

/** The two mixed-frame declines share their opening clause with the report's wording. */
const MIXED_MESH_HEAD =
  'A mesh layer with no coordinate system reads as Y-up from its point layout, and the other visible layers are Z-up';
const MIXED_GLTF_HEAD = 'A glTF or GLB layer is Y-up by specification, and the other visible layers are Z-up';
/** How terrain analysis ends a mixed-frame decline. */
const TERRAIN_MIXED_TAIL = ', so together they describe no single surface. Hide or lock one side, then run.';
/**
 * How the space and object report ends it. The report has no surface and no
 * run; choosing an option under "Treat scan as" routes the scan again, which
 * gathers afresh, so that is the step after hiding or locking a layer.
 */
const REPORT_MIXED_TAIL =
  ', so they are not in one frame. Hide or lock one side, then choose an option under "Treat scan as" again.';

/**
 * The decline when several visible, unlocked layers would be combined and none
 * of them has proven it shares a frame with the others, so nothing gathers.
 */
export const UNPROVEN_FRAME_REASON =
  'Terrain analysis combines every visible, unlocked layer, and these layers have not proven they share a frame. Hide or lock all but one layer, then run.';
/** How the space and object report states {@link UNPROVEN_FRAME_REASON}. */
const REPORT_UNPROVEN_FRAME =
  'The visible layers have not proven they share a frame, so they are not measured together. Hide or lock all but one layer, then choose an option under "Treat scan as" again.';

/**
 * A decline's cause as the space and object report states it: without the
 * terrain lead, and with a mixed-frame or unproven-frame decline's terrain
 * ending replaced by the report's. Other text is returned as it is.
 */
export function gatherDeclineCause(reason: string): string {
  if (reason === UNPROVEN_FRAME_REASON) return REPORT_UNPROVEN_FRAME;
  const cause = reason.startsWith(TERRAIN_DECLINE_LEAD) ? reason.slice(TERRAIN_DECLINE_LEAD.length) : reason;
  return cause.endsWith(TERRAIN_MIXED_TAIL) ? cause.slice(0, -TERRAIN_MIXED_TAIL.length) + REPORT_MIXED_TAIL : cause;
}

/** The decline for a glTF or GLB source under a CRS. */
export function gltfUnderCrsReason(label: string): string {
  return `${TERRAIN_DECLINE_LEAD}${gltfUnderCrsAxisReason(label)}`;
}

/** The decline for a local mesh that reads as Y-up beside Z-up layers. */
export const MIXED_FRAME_REASON = TERRAIN_DECLINE_LEAD + MIXED_MESH_HEAD + TERRAIN_MIXED_TAIL;

/** The decline for a glTF or GLB layer, Y-up by specification, beside Z-up layers. */
export const MIXED_GLTF_FRAME_REASON = TERRAIN_DECLINE_LEAD + MIXED_GLTF_HEAD + TERRAIN_MIXED_TAIL;

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
    // its own points decide it. classifyScanShape strides to at most 60,000
    // samples, so reading a whole layer costs the same as reading the gather.
    const own = s.layerPoints;
    const detected = local && !isYUpBySpec(s.format)
      ? (classifyScanShape(own && own.length > 0 ? own : positions).up === 'y' ? 'y' : 'z')
      : undefined;
    const f = resolveLayerUpFrame({ format: s.format, crs: s.crs, ...(detected ? { detected } : {}) });
    if (!f.ok) return { ok: false, reason: `${TERRAIN_DECLINE_LEAD}${f.reason}` };
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
