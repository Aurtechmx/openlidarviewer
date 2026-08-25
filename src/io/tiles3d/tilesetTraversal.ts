/**
 * tilesetTraversal.ts — decide which tiles a view needs.
 *
 * This is where the four 3D Tiles primitives meet. Until now each was correct
 * in isolation and reachable from nothing:
 *
 *   tileTransform        cumulative placement down the tree
 *   boundingVolume       conservative render-space bounds
 *   screenSpaceError     the refinement measure
 *   implicitCoordinates  children of an implicitly tiled subtree
 *
 * Composing them is what turns four verified modules into a traversal, and it
 * is also the first time their assumptions have to agree.
 *
 * Still pure. No fetching, no scheduler, no renderer. Subtree availability is
 * passed in rather than resolved, so an implicit tileset can be traversed here
 * while the resource layer that fetches subtrees stays a separate concern.
 *
 * REFINEMENT, and the part that is easy to get subtly wrong:
 *
 *   REPLACE  a refined tile's own content is replaced by its children, so the
 *            parent must NOT be rendered once its children are selected.
 *   ADD      a refined tile's content is additive, so the parent IS rendered
 *            alongside its children.
 *
 * Treating ADD as REPLACE drops geometry the tileset intended to keep, and the
 * result still looks like a plausible scene, which is why both paths are tested
 * rather than assumed.
 */

import type { BoundingVolume, Tile, Tileset } from './tileset';
import {
  IDENTITY_4X4,
  transformPoint,
  walkTilePlacements,
  type Mat4,
  type PlacedTile,
} from './tileTransform';
import { boxToAabb, regionToAabb, sphereToAabb, type Aabb } from './boundingVolume';
import { screenSpaceError, shouldRefine, type CameraSseInput } from './screenSpaceError';
import {
  childCoordinates,
  isAvailable,
  subdivideBoundingVolume,
  geometricErrorForLevel,
  tileIdFor,
  tileIndexWithinSubtree,
  type Availability,
  type SubdivisionScheme,
  type TileCoordinate,
} from './implicitCoordinates';

/** A camera, minus the geometric error each tile supplies for itself. */
export type ViewCamera =
  | {
      readonly kind: 'perspective';
      readonly positionEcef: readonly [number, number, number];
      readonly viewportHeightPx: number;
      readonly verticalFov: number;
    }
  | {
      readonly kind: 'orthographic';
      readonly positionEcef: readonly [number, number, number];
      readonly viewportHeightPx: number;
      readonly orthographicWorldHeight: number;
    };

export interface TraversalOptions {
  /** Refine while the screen-space error exceeds this, in pixels. */
  readonly maxScreenSpaceErrorPx: number;
  /** Stop descending past this depth. Guards a pathological tileset. */
  readonly maxDepth?: number;
  /** Root transform, when the tileset is placed by something above it. */
  readonly rootTransform?: Mat4;
}

/** One tile the view needs, with the numbers that decided it. */
export interface SelectedTile {
  readonly placed: PlacedTile;
  readonly aabb: Aabb;
  readonly distance: number;
  readonly screenSpaceError: number;
  /** True when this tile's own content is drawn. */
  readonly renders: boolean;
}

/**
 * The render-space AABB of a bounding volume.
 *
 * A `region` is EPSG:4979 and already absolute, so it is converted directly
 * rather than through the tile transform. Box and sphere arrive already
 * transformed by the walk, so they are converted as they stand. Returns null
 * for a volume carrying none of the three, which `tileset.ts` refuses to parse
 * but which a hand-built Tile can still produce.
 */
export function volumeToAabb(volume: BoundingVolume): Aabb | null {
  if (volume.region) return regionToAabb(volume.region);
  if (volume.box) return boxToAabb(volume.box);
  if (volume.sphere) return sphereToAabb(volume.sphere);
  return null;
}

/**
 * Distance from a point to an AABB, zero when inside.
 *
 * Distance to the VOLUME rather than to its centre. Centre distance
 * under-reports error for a large tile the camera is standing inside, which is
 * exactly the tile that most needs refining.
 */
export function distanceToAabb(aabb: Aabb, p: readonly [number, number, number]): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const over = Math.max(aabb.min[i]! - p[i]!, 0, p[i]! - aabb.max[i]!);
    sum += over * over;
  }
  return Math.sqrt(sum);
}

/**
 * Screen-space error of one tile under one camera.
 *
 * Exported because the detail search in `tilesetDetail.ts` has to measure the
 * SAME quantity `selectTiles` refines on, over tiles a selection does not
 * return: under REPLACE refinement a refined parent is absent from the
 * selection, and its error is exactly the threshold at which it stops refining.
 * A second implementation of this arithmetic would be a second definition of
 * what a level is.
 */
export function tileScreenSpaceError(
  camera: ViewCamera,
  geometricError: number,
  distance: number,
): number {
  return screenSpaceError(sseInputFor(camera, geometricError, distance));
}

/** The SSE input for one tile under one camera. */
function sseInputFor(camera: ViewCamera, geometricError: number, distance: number): CameraSseInput {
  if (camera.kind === 'orthographic') {
    return {
      kind: 'orthographic',
      geometricError,
      viewportHeightPx: camera.viewportHeightPx,
      orthographicWorldHeight: camera.orthographicWorldHeight,
    };
  }
  return {
    kind: 'perspective',
    geometricError,
    viewportHeightPx: camera.viewportHeightPx,
    distance,
    verticalFov: camera.verticalFov,
  };
}

/**
 * Select the tiles a view needs from an explicit tileset.
 *
 * Descends while the screen-space error exceeds the threshold and children
 * exist. A tile with no children is a leaf and always renders when reached,
 * however large its error, because there is nothing further to descend to and
 * dropping it would leave a hole.
 */
export function selectTiles(
  tileset: Tileset,
  camera: ViewCamera,
  options: TraversalOptions,
): SelectedTile[] {
  const maxDepth = options.maxDepth ?? 32;
  const rootTransform = options.rootTransform ?? IDENTITY_4X4;
  const out: SelectedTile[] = [];

  // The walk already carries the cumulative transform, so this only decides
  // which of its tiles to keep.
  const byTile = new Map<Tile, PlacedTile>();
  for (const placed of walkTilePlacements(tileset.root, rootTransform)) {
    byTile.set(placed.tile, placed);
  }

  const visit = (tile: Tile): void => {
    const placed = byTile.get(tile);
    if (!placed || placed.depth > maxDepth) return;

    const aabb = volumeToAabb(placed.boundingVolume);
    if (!aabb) return;

    const distance = distanceToAabb(aabb, camera.positionEcef as [number, number, number]);
    const sse = tileScreenSpaceError(camera, placed.geometricError, distance);

    const hasChildren = tile.children.length > 0;
    const refine = hasChildren && placed.depth < maxDepth && shouldRefine(sse, options.maxScreenSpaceErrorPx);

    // REPLACE hides the parent behind its children; ADD keeps both. A leaf
    // renders regardless, because there is nothing below it to stand in.
    const renders = !refine || tile.refine === 'ADD';
    if (renders) out.push({ placed, aabb, distance, screenSpaceError: sse, renders: true });

    if (refine) for (const child of tile.children) visit(child);
  };

  visit(tileset.root);
  return out;
}

/** One implicitly tiled node, materialised only because the traversal reached it. */
export interface ImplicitTile {
  readonly coordinate: TileCoordinate;
  readonly id: string;
  readonly boundingVolume: BoundingVolume;
  readonly geometricError: number;
}

export interface ImplicitSubtreeInput {
  readonly scheme: SubdivisionScheme;
  readonly rootCoordinate: TileCoordinate;
  readonly rootBoundingVolume: BoundingVolume;
  readonly rootGeometricError: number;
  /** Levels this subtree covers below its root. */
  readonly subtreeLevels: number;
  readonly tileAvailability: Availability;
}

/**
 * Materialise the available tiles of one implicit subtree, lazily.
 *
 * Nothing is pre-created: a node exists only once the walk descends to it, so a
 * subtree that declares many levels costs only the part actually reached. An
 * unavailable tile stops that branch, since its descendants cannot be addressed
 * through a parent that does not exist.
 */
export function* walkImplicitSubtree(input: ImplicitSubtreeInput): Generator<ImplicitTile> {
  const { scheme, rootCoordinate, subtreeLevels } = input;

  interface Frame {
    coord: TileCoordinate;
    volume: BoundingVolume;
    error: number;
  }
  const stack: Frame[] = [
    { coord: rootCoordinate, volume: input.rootBoundingVolume, error: input.rootGeometricError },
  ];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const depth = frame.coord.level - rootCoordinate.level;
    if (depth < 0 || depth >= subtreeLevels) continue;

    const index = tileIndexWithinSubtree(scheme, frame.coord, rootCoordinate.level);
    if (!isAvailable(input.tileAvailability, index)) continue;

    yield {
      coordinate: frame.coord,
      id: tileIdFor(scheme, frame.coord),
      boundingVolume: frame.volume,
      geometricError: frame.error,
    };

    if (depth + 1 >= subtreeLevels) continue;
    const children = childCoordinates(scheme, frame.coord);
    for (let i = children.length - 1; i >= 0; i--) {
      const volume = subdivideBoundingVolume(scheme, frame.volume, i);
      // A volume that cannot be subdivided exactly stops the branch rather than
      // being approximated, because an approximate bound culls real geometry.
      if (!volume) continue;
      stack.push({
        coord: children[i]!,
        volume,
        error: geometricErrorForLevel(input.rootGeometricError, children[i]!.level - rootCoordinate.level),
      });
    }
  }
}

/** The render-space centre of a placed tile, for callers that need one point. */
export function placedTileCentre(placed: PlacedTile): [number, number, number] | null {
  const aabb = volumeToAabb(placed.boundingVolume);
  if (!aabb) return null;
  return [
    (aabb.min[0]! + aabb.max[0]!) / 2,
    (aabb.min[1]! + aabb.max[1]!) / 2,
    (aabb.min[2]! + aabb.max[2]!) / 2,
  ];
}

/** Re-exported so a caller composing a root placement needs one import. */
export { transformPoint };
