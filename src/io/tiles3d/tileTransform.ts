/**
 * tileTransform.ts — the 3D Tiles tile transform, composed and applied.
 *
 * A tile's `transform` is a column-major 4x4 affine from that tile's local
 * space to its PARENT's space. Placing a tile therefore needs the product of
 * every transform from the root down, and the order is not a matter of taste:
 * composing the other way puts a tile somewhere plausible rather than
 * somewhere wrong, which is the hardest kind of error to notice.
 *
 * `tileset.ts` validates that a transform is sixteen finite numbers and stops
 * there. This module is what turns a validated transform into a placement.
 *
 * WHAT THE TRANSFORM APPLIES TO, per the 1.1 specification:
 *
 *   content                      yes
 *   `box` bounding volume        yes
 *   `sphere` bounding volume     yes
 *   content bounding volume      yes
 *   viewer request volume        yes
 *   `region` bounding volume     NO
 *   `geometricError`             scaled by the largest scaling factor
 *
 * The `region` exemption is the one that bites. A region is stated in
 * EPSG:4979 geographic coordinates, so it is already absolute; multiplying it
 * by a tile transform treats longitude as if it were a metre and produces a
 * volume in no coordinate system at all. It is exempt because it does not need
 * transforming, not because transforming it is merely inaccurate.
 *
 * Pure: no fetch, no DOM, no renderer types. Column-major throughout, matching
 * both the specification and WebGL, so `m[column * 4 + row]`.
 */

import type { BoundingVolume, Tile } from './tileset';

/** A column-major 4x4, sixteen finite numbers. */
export type Mat4 = readonly number[];

export type Vec3 = readonly [number, number, number];

/** The column-major identity, which is also the transform of a tile with none. */
export const IDENTITY_4X4: Mat4 = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/**
 * `parent * child`, the cumulative transform of a child tile.
 *
 * Order is the whole content of this function. The child's transform maps
 * child-local to parent space, and the parent's cumulative maps parent to
 * root, so root-space = parent_cumulative · child_local. Reversing the operands
 * yields a matrix that is still finite, still invertible and still wrong.
 */
export function composeTileTransform(parent: Mat4, child: Mat4): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += parent[k * 4 + row]! * child[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * The cumulative transform for a path of tiles from the root down.
 *
 * A tile without its own transform contributes the identity rather than being
 * skipped, so a caller can hand over the whole path including the gaps.
 */
export function cumulativeTransform(path: readonly (Mat4 | null | undefined)[]): number[] {
  let acc: Mat4 = IDENTITY_4X4;
  for (const step of path) {
    if (!step) continue;
    acc = composeTileTransform(acc, step);
  }
  return [...acc];
}

/** A point through the full affine, translation included. */
export function transformPoint(m: Mat4, p: Vec3): [number, number, number] {
  const [x, y, z] = p;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/**
 * A direction through the linear part only.
 *
 * Half-axes and normals are directions, not positions: adding the translation
 * to one moves the shape twice and leaves the box centred somewhere it is not.
 */
export function transformDirection(m: Mat4, v: Vec3): [number, number, number] {
  const [x, y, z] = v;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ];
}

/**
 * The largest scaling factor of the linear part.
 *
 * Taken as the longest of the three transformed basis vectors, which is what
 * the specification's geometric-error scaling means for a non-uniform scale:
 * the error must not shrink on the axis that grew, so the maximum is the only
 * safe choice. A mean would under-report and a minimum would under-report
 * badly, and both look correct under the uniform scale that most tilesets use.
 */
export function largestScale(m: Mat4): number {
  const cx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const cy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const cz = Math.hypot(m[8]!, m[9]!, m[10]!);
  return Math.max(cx, cy, cz);
}

/** A tile's geometric error under its cumulative transform. */
export function transformGeometricError(m: Mat4, geometricError: number): number {
  return geometricError * largestScale(m);
}

/**
 * A `box` volume through the transform: centre as a position, each half-axis
 * as a direction. The result is still twelve numbers in the same layout.
 */
export function transformBox(m: Mat4, box: readonly number[]): number[] {
  const c = transformPoint(m, [box[0]!, box[1]!, box[2]!]);
  const ax = transformDirection(m, [box[3]!, box[4]!, box[5]!]);
  const ay = transformDirection(m, [box[6]!, box[7]!, box[8]!]);
  const az = transformDirection(m, [box[9]!, box[10]!, box[11]!]);
  return [...c, ...ax, ...ay, ...az];
}

/**
 * A `sphere` volume through the transform.
 *
 * The radius takes the largest scaling factor, so a non-uniform scale grows the
 * sphere to enclose the ellipsoid it really became. That is conservative on
 * purpose: a bounding volume that is too small culls geometry that should have
 * been drawn, and a viewer that culls what it should draw looks like a decoder
 * bug rather than a bounds bug.
 */
export function transformSphere(m: Mat4, sphere: readonly number[]): number[] {
  const c = transformPoint(m, [sphere[0]!, sphere[1]!, sphere[2]!]);
  return [...c, sphere[3]! * largestScale(m)];
}

/**
 * A bounding volume through the transform, leaving `region` alone.
 *
 * Returns a new volume; the input is not mutated. A volume carrying only a
 * region comes back unchanged, which is the specification's behaviour and not
 * an omission.
 */
export function transformBoundingVolume(m: Mat4, volume: BoundingVolume): BoundingVolume {
  const out: { box?: number[]; sphere?: number[]; region?: readonly number[] } = {};
  if (volume.box) out.box = transformBox(m, volume.box);
  if (volume.sphere) out.sphere = transformSphere(m, volume.sphere);
  // EPSG:4979 and therefore absolute. Carried through untouched.
  if (volume.region) out.region = volume.region;
  return out as BoundingVolume;
}

/**
 * Whether a transform is close enough to the identity to skip.
 *
 * Worth asking before walking a deep tileset: most tiles carry no transform at
 * all, and the ones that do are usually only at the root.
 */
export function isIdentityTransform(m: Mat4, epsilon = 0): boolean {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(m[i]! - IDENTITY_4X4[i]!) > epsilon) return false;
  }
  return true;
}

/** A tile resolved into the tileset's root space. */
export interface PlacedTile {
  readonly tile: Tile;
  /** Cumulative root-to-tile transform, column-major. */
  readonly transform: Mat4;
  /** The tile's bounding volume in root space, `region` left as authored. */
  readonly boundingVolume: BoundingVolume;
  /** The tile's geometric error scaled by the cumulative transform. */
  readonly geometricError: number;
  /** Root is 0. */
  readonly depth: number;
}

/**
 * Walk a tileset top-down, resolving every tile into root space.
 *
 * This is the shape §7.4 asks for: the cumulative transform is computed as the
 * walk descends, so each tile sees its parent's product rather than
 * recomputing the chain from the root. Depth-first and eager, because a
 * tileset's own JSON is already in memory by the time this runs; streaming a
 * hierarchy that arrives over the wire is a different traversal and belongs
 * with the scheduler, not here.
 *
 * External tileset contents are not followed. A tile whose content URI names
 * another `tileset.json` is yielded as itself, and resolving it is the
 * resource layer's job.
 */
export function* walkTilePlacements(
  root: Tile,
  rootTransform: Mat4 = IDENTITY_4X4,
): Generator<PlacedTile> {
  const stack: { tile: Tile; parent: Mat4; depth: number }[] = [
    { tile: root, parent: rootTransform, depth: 0 },
  ];

  while (stack.length > 0) {
    const { tile, parent, depth } = stack.pop()!;
    const transform = tile.transform ? composeTileTransform(parent, tile.transform) : parent;

    yield {
      tile,
      transform,
      boundingVolume: transformBoundingVolume(transform, tile.boundingVolume),
      geometricError: transformGeometricError(transform, tile.geometricError),
      depth,
    };

    // Pushed in reverse so the walk yields children in authored order, which is
    // what a reader comparing against the JSON expects.
    for (let i = tile.children.length - 1; i >= 0; i--) {
      stack.push({ tile: tile.children[i]!, parent: transform, depth: depth + 1 });
    }
  }
}
