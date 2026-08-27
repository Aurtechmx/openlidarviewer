/**
 * tilesetFrame.ts — which frame a 3D Tiles tileset places its points in.
 *
 * A tileset's root space is Cartesian and the specification says Z is up for a
 * LOCAL one. It does not say a tileset IS local, and the common authoring for a
 * globe-scale dataset is WGS84 geocentric (EPSG:4978), where +Z is the polar
 * axis and local up is roughly the ellipsoid normal. The two differ by the
 * co-latitude: at 25°N that is over sixty degrees. A cloud recentred out of
 * ECEF and never rotated fits the camera and draws as a plausible scene, and
 * every height, slope, terrain derivative and up-dependent clip taken off it is
 * measured along an axis that is not vertical.
 *
 * WHAT COUNTS AS A DECLARATION, and why the magnitudes are not one.
 *
 * A `region` bounding volume is stated in EPSG:4979 geographic coordinates and
 * is the one volume form the tile transform does NOT apply to (see
 * `tileTransform.ts`). It is therefore an absolute geographic statement about
 * where the tile's TRANSFORMED content lies, which is only meaningful if the
 * transformed content is in the global geocentric frame those coordinates are
 * defined against. A tileset carrying one has declared its root frame; that is
 * the declaration this module reads.
 *
 * What it will NOT read is the size of the numbers. A coordinate near the
 * Earth's radius may be ECEF, and it may equally be a projected grid with a
 * large false easting or a local model authored far from its own origin.
 * Nothing separates those by magnitude, and a detector that guessed would put
 * a fabricated vertical datum into every report downstream. A tileset that
 * declares nothing is UNKNOWN, and stays unknown.
 *
 * WHAT SURVIVES AN UNKNOWN FRAME. The unit does. 3D Tiles establishes metres
 * for linear distances regardless of which CRS a particular tileset sits in, so
 * an unresolved frame is recorded with a vertical reference of `unknown` and a
 * linear unit of `metre`. Discarding the unit alongside the frame would throw
 * away a fact the format actually states.
 *
 * Pure: no fetch, no DOM, no renderer types. Float64 throughout.
 */

import {
  createLocalEnuFrame,
  ecefToGeodeticAngles,
  type SpatialFrame,
  type Vec3,
} from '../../geo/frame/spatialFrame';
import type { CloudFrameProvenance } from '../../geo/frame/frameProvenance';
import type { Tile, Tileset } from './tileset';

/** The declaration text recorded when a region bounding volume establishes the frame. */
export const REGION_DECLARES_GEOCENTRIC =
  'region bounding volume (EPSG:4979), which fixes the root frame as WGS84 geocentric';

/** What the document itself says about its root frame. */
export interface TilesetFrameDeclaration {
  /** True only when the document states it, never when the coordinates suggest it. */
  readonly geocentric: boolean;
  /** The statement that established it, or `null` when nothing did. */
  readonly declaredBy: string | null;
}

/** Six finite numbers, the shape `parseTileset` accepts for a region. */
function isRegion(volume: { readonly region?: readonly number[] }): boolean {
  const r = volume.region;
  return Array.isArray(r) && r.length === 6 && r.every((v) => Number.isFinite(v));
}

/**
 * Read the tileset's own statement about its root frame.
 *
 * The whole tree is walked rather than the root alone: a root may carry a box
 * or a sphere while its children carry regions, and a region anywhere in the
 * tree makes the same absolute geographic statement about the frame all of them
 * share. The walk is iterative and the tree is already bounded in depth and
 * count by `parseTileset`, so it terminates on any document that parsed.
 */
export function declaredTilesetFrame(tileset: Tileset): TilesetFrameDeclaration {
  const stack: Tile[] = [tileset.root];
  while (stack.length > 0) {
    const tile = stack.pop()!;
    if (isRegion(tile.boundingVolume)) {
      return { geocentric: true, declaredBy: REGION_DECLARES_GEOCENTRIC };
    }
    for (const child of tile.children) stack.push(child);
  }
  return { geocentric: false, declaredBy: null };
}

/** A frame to draw a tileset in, with the record of how it was arrived at. */
export interface ResolvedTilesetFrame {
  /**
   * The conversion from root-frame coordinates to render coordinates, or `null`
   * when the frame was not established.
   *
   * `null` rather than a translated stand-in on purpose. A caller that recentres
   * has done something a frame object would make look like a decision, and the
   * absence is what forces it to record `unknown` instead of an up axis it
   * never established.
   */
  readonly frame: SpatialFrame | null;
  readonly provenance: CloudFrameProvenance;
}

/**
 * Resolve the frame a tileset's merged points should be drawn in.
 *
 * `anchor` is a root-frame coordinate inside the data — the centre of its
 * extent is what the caller has — and it becomes the tangent point of the ENU
 * frame. It is refused when it is not finite, and at the geocentre, where the
 * ellipsoid normal is not defined and any rotation would be arbitrary. Both
 * refusals produce `unknown`, never a frame built on a guessed anchor.
 */
export function resolveTilesetFrame(
  tileset: Tileset,
  anchor: Vec3 | null,
): ResolvedTilesetFrame {
  const established = establishedTilesetFrame(tileset, anchor);
  return {
    frame: established === null ? null : createLocalEnuFrame(established.anchor),
    provenance: frameProvenanceOf(established),
  };
}

/**
 * The anchor an ENU frame may be built on, or `null` when the tileset gave no
 * grounds to build one.
 *
 * The single place the question is decided, because two callers ask it: the
 * merged reader below, and the streaming reader that needs the same rotation as
 * a matrix. A second copy of the guard is how a document ends up ROTATED by one
 * path and recorded as unrotated by the other, or the reverse: recorded as
 * levelled while its tiles were left in ECEF. Either way the scene draws and
 * only the numbers are wrong.
 *
 * The anchor is refused when it is not finite, and at the geocentre, where the
 * ellipsoid normal is not defined and any rotation would be arbitrary.
 */
function establishedTilesetFrame(
  tileset: Tileset,
  anchor: Vec3 | null,
): { readonly anchor: Vec3; readonly declaredBy: string } | null {
  const declaration = declaredTilesetFrame(tileset);
  const usable =
    anchor !== null &&
    anchor.every((v) => Number.isFinite(v)) &&
    Math.hypot(anchor[0], anchor[1], anchor[2]) > 0;
  if (!declaration.geocentric || !usable || declaration.declaredBy === null) return null;
  return { anchor, declaredBy: declaration.declaredBy };
}

/** The record kept beside a cloud, for an established frame and for none. */
function frameProvenanceOf(
  established: { readonly anchor: Vec3; readonly declaredBy: string } | null,
): CloudFrameProvenance {
  if (established === null) {
    return {
      basis: 'unknown',
      declaredBy: null,
      verticalReference: 'unknown',
      linearUnit: 'metre',
    };
  }
  const [x, y, z] = established.anchor;
  return {
    basis: 'local-enu',
    declaredBy: established.declaredBy,
    anchor: [x, y, z],
    // Heights in an ENU frame tangent to the WGS84 ellipsoid are heights
    // above that ellipsoid. 3D Tiles carries no vertical datum, so this is
    // the only reference available and never becomes an orthometric one.
    verticalReference: 'ellipsoidal',
    linearUnit: 'metre',
  };
}

/** A frame for a STREAMED tileset: the root transform, and how it was arrived at. */
export interface StreamingTilesetFrame {
  /**
   * The rotation to put at the root of the tile tree, or `null` when the frame
   * was not established. A matrix rather than a `SpatialFrame` because a
   * streaming reader never holds every point: it places each tile by composing
   * transforms down the tree.
   */
  readonly rootTransform: readonly number[] | null;
  readonly provenance: CloudFrameProvenance;
}

/**
 * Resolve the frame a STREAMED tileset's tiles should be placed in.
 *
 * The same decision `resolveTilesetFrame` makes, expressed as the matrix the
 * streaming path needs, so the transform that is APPLIED and the provenance
 * that is RECORDED come out of one call and cannot disagree. A caller that
 * asked for them separately could rotate without recording it, or record a
 * levelled frame it never applied.
 *
 * `anchor` is the centre of the ROOT bounding volume rather than of the loaded
 * points: a streaming resident set changes as the camera moves, and an anchor
 * that moved with it would give the same tile different render coordinates on
 * different frames.
 */
export function resolveStreamingTilesetFrame(
  tileset: Tileset,
  anchor: Vec3 | null,
): StreamingTilesetFrame {
  const established = establishedTilesetFrame(tileset, anchor);
  return {
    rootTransform: established === null ? null : enuFrameMatrix(established.anchor),
    provenance: frameProvenanceOf(established),
  };
}

/**
 * The mid-point of the finite extent of interleaved xyz triples, or `null` when
 * no point is finite.
 *
 * The extent mid-point rather than the mean: it is decided by the two extreme
 * coordinates on each axis and so does not move when tiles of very different
 * point counts are merged, which keeps the anchor (and with it the rotation,
 * and every render coordinate) the same for the same geometry.
 *
 * Non-finite coordinates are skipped instead of poisoning the result. They are
 * removed further down by `sanitizeAndRecenter`, but the anchor is chosen
 * before that runs, and a NaN anchor would rotate every point in the cloud to
 * NaN and lose the whole scene rather than one bad point.
 */
export function finiteExtentCentre(xyz: Float64Array): Vec3 | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let seen = false;
  for (let i = 0; i + 2 < xyz.length; i += 3) {
    const x = xyz[i]!, y = xyz[i + 1]!, z = xyz[i + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    seen = true;
    if (x < min[0]!) min[0] = x;
    if (y < min[1]!) min[1] = y;
    if (z < min[2]!) min[2] = z;
    if (x > max[0]!) max[0] = x;
    if (y > max[1]!) max[1] = y;
    if (z > max[2]!) max[2] = z;
  }
  if (!seen) return null;
  return [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
}

/**
 * The ENU frame as a column-major 4x4, for a reader that composes transforms
 * rather than mapping points one at a time.
 *
 * `SpatialFrame.sourceToRenderPoint` maps a single point, which suits a reader
 * that has already merged every tile into one buffer. A streaming reader never
 * holds that buffer: it places each tile by composing matrices down the tree,
 * so it needs the same rotation as a matrix it can put at the root.
 *
 * The frame is `R · (p − anchor)` with the rows of `R` being east, north and
 * up, so the matrix is `R` with a translation of `−R·anchor`. Applying this at
 * the root gives every tile the same rotation the merged reader applies to
 * every point, which is what keeps the two paths agreeing.
 */
export function enuFrameMatrix(anchor: Vec3): number[] {
  const { lat, lon } = ecefToGeodeticAngles(anchor);
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const sLon = Math.sin(lon), cLon = Math.cos(lon);
  // Rows of R: east, north, up. Same construction as createLocalEnuFrame.
  const e: Vec3 = [-sLon, cLon, 0];
  const n: Vec3 = [-sLat * cLon, -sLat * sLon, cLat];
  const u: Vec3 = [cLat * cLon, cLat * sLon, sLat];
  const dot = (r: Vec3) => r[0] * anchor[0] + r[1] * anchor[1] + r[2] * anchor[2];
  // Column-major: the rotation occupies the first three columns as R's COLUMNS,
  // which for a row-listed R means transposing here.
  return [
    e[0], n[0], u[0], 0,
    e[1], n[1], u[1], 0,
    e[2], n[2], u[2], 0,
    -dot(e), -dot(n), -dot(u), 1,
  ];
}
