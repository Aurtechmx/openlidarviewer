/**
 * implicitCoordinates.ts — the coordinate and availability arithmetic of
 * 3D Tiles 1.1 implicit tiling, as pure functions.
 *
 * Implicit tiling states a hierarchy by a rule instead of by JSON: a
 * subdivision scheme, a root bounding volume, and per-subtree availability
 * bitstreams. Everything a consumer needs about a tile — its children, its
 * parent, its bounding volume, its geometric error, whether it exists at all —
 * follows from its (level, x, y[, z]) coordinate and that rule.
 *
 * This module is only the maths. It builds no nodes, holds no state, fetches
 * nothing, and knows nothing about the viewer. A hierarchy adapter can call
 * these functions once the explicit path is stable; the functions do not depend
 * on that adapter existing.
 *
 * MORTON ENCODING. `mortonIndex` interleaves LSB-first with x in the lowest bit
 * of each group: bit 0 is x bit 0, bit 1 is y bit 0, and for OCTREE bit 2 is
 * z bit 0, then the next group holds bit 1 of each axis, and so on. So for
 * QUADTREE x=1,y=0 is 1 and x=0,y=1 is 2; for OCTREE z=1 alone is 4.
 *
 * INTEGER TYPE. The interleave runs on BigInt so no intermediate shift can lose
 * a bit, and the result is narrowed to `number` only after it is checked to be
 * an exact safe integer. That check is what sets the level limit: a QUADTREE
 * level costs 2 bits and an OCTREE level costs 3, so with 53 bits of exact
 * integer available the highest addressable levels are 26 for QUADTREE and 17
 * for OCTREE. A coordinate above that is refused rather than silently rounded,
 * because a rounded Morton index addresses the wrong availability bit and would
 * report a real tile as missing or a missing tile as real.
 */

import type { BoundingVolume } from './tileset';

export type SubdivisionScheme = 'QUADTREE' | 'OCTREE';

export interface TileCoordinate {
  readonly level: number;
  readonly x: number;
  readonly y: number;
  /** OCTREE only. QUADTREE coordinates carry no z. */
  readonly z?: number;
}

/** Children per tile, per scheme. */
const CHILD_COUNT: Record<SubdivisionScheme, number> = { QUADTREE: 4, OCTREE: 8 };

/**
 * Highest level whose Morton index is still an exact safe integer.
 * 53 exact bits / bits-per-level, floored.
 */
export const MAX_LEVEL: Record<SubdivisionScheme, number> = { QUADTREE: 26, OCTREE: 17 };

export function childCount(scheme: SubdivisionScheme): number {
  return CHILD_COUNT[scheme];
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Reject anything that is not a well-formed coordinate for the scheme.
 *
 * The checks are strict on purpose. A negative or fractional ordinate, an
 * ordinate outside the 2^level grid of its own level, a QUADTREE coordinate
 * carrying a z, or an OCTREE coordinate missing one, all produce a Morton index
 * that addresses some other tile's availability bit. Failing loudly here is the
 * only place that mistake is still legible.
 */
export function assertCoordinate(scheme: SubdivisionScheme, coord: TileCoordinate): void {
  const { level, x, y, z } = coord;
  if (!isIndex(level)) throw new Error('implicit tiling: level must be a non-negative integer.');
  if (level > MAX_LEVEL[scheme]) {
    throw new Error(
      `implicit tiling: ${scheme} level ${level} exceeds the exact-integer limit of ${MAX_LEVEL[scheme]}.`,
    );
  }
  if (!isIndex(x) || !isIndex(y)) {
    throw new Error('implicit tiling: x and y must be non-negative integers.');
  }
  if (scheme === 'OCTREE') {
    if (!isIndex(z)) throw new Error('implicit tiling: an OCTREE coordinate needs a non-negative integer z.');
  } else if (z !== undefined) {
    throw new Error('implicit tiling: a QUADTREE coordinate must not carry a z.');
  }
  const size = 2 ** level;
  const over = [x, y, ...(scheme === 'OCTREE' ? [z as number] : [])].some((v) => v >= size);
  if (over) {
    throw new Error(`implicit tiling: a coordinate ordinate is outside the ${size}-wide grid of level ${level}.`);
  }
}

/**
 * The children of a tile, in Morton order of the local offset
 * (index = dx + 2*dy + 4*dz), which is the same order `subdivideBoundingVolume`
 * uses for `childIndex`.
 */
export function childCoordinates(scheme: SubdivisionScheme, coord: TileCoordinate): TileCoordinate[] {
  assertCoordinate(scheme, coord);
  const level = coord.level + 1;
  if (level > MAX_LEVEL[scheme]) {
    throw new Error(
      `implicit tiling: ${scheme} children of level ${coord.level} exceed the exact-integer limit of ${MAX_LEVEL[scheme]}.`,
    );
  }
  const out: TileCoordinate[] = [];
  for (let i = 0; i < CHILD_COUNT[scheme]; i += 1) {
    const dx = i & 1;
    const dy = (i >> 1) & 1;
    const x = coord.x * 2 + dx;
    const y = coord.y * 2 + dy;
    if (scheme === 'QUADTREE') {
      out.push({ level, x, y });
    } else {
      const dz = (i >> 2) & 1;
      out.push({ level, x, y, z: (coord.z as number) * 2 + dz });
    }
  }
  return out;
}

/** The parent of a tile, or null at level 0 where there is none. */
export function parentCoordinate(scheme: SubdivisionScheme, coord: TileCoordinate): TileCoordinate | null {
  assertCoordinate(scheme, coord);
  if (coord.level === 0) return null;
  const level = coord.level - 1;
  const x = Math.floor(coord.x / 2);
  const y = Math.floor(coord.y / 2);
  if (scheme === 'QUADTREE') return { level, x, y };
  return { level, x, y, z: Math.floor((coord.z as number) / 2) };
}

/**
 * A stable string id for a coordinate.
 *
 * The scheme is part of the id because a QUADTREE and an OCTREE tile can share
 * (level, x, y), and the ordinates are joined by a separator that cannot occur
 * inside a decimal integer, so no two distinct coordinates can produce the same
 * string.
 */
export function tileIdFor(scheme: SubdivisionScheme, coord: TileCoordinate): string {
  assertCoordinate(scheme, coord);
  const head = `${scheme}/${coord.level}/${coord.x}/${coord.y}`;
  return scheme === 'QUADTREE' ? head : `${head}/${coord.z as number}`;
}

/**
 * The Morton (Z-order) index of a coordinate within its own level.
 * See the module header for the bit order and the level limit.
 */
export function mortonIndex(scheme: SubdivisionScheme, coord: TileCoordinate): number {
  assertCoordinate(scheme, coord);
  const axes = scheme === 'QUADTREE' ? [coord.x, coord.y] : [coord.x, coord.y, coord.z as number];
  const stride = BigInt(axes.length);
  let acc = 0n;
  axes.forEach((axis, a) => {
    let bits = BigInt(axis);
    let bit = 0n;
    while (bits > 0n) {
      if (bits & 1n) acc |= 1n << (bit * stride + BigInt(a));
      bits >>= 1n;
      bit += 1n;
    }
  });
  if (acc > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('implicit tiling: the Morton index is not an exact safe integer.');
  }
  return Number(acc);
}

/**
 * The index that addresses a tile in a subtree availability bitstream: the
 * count of every tile in the levels above it within the subtree, plus its
 * Morton index at its own level.
 *
 * The Morton index is taken over the coordinate's position *within the
 * subtree*, which is the low bits of each ordinate once the subtree root's
 * contribution is shifted out. That is what makes the index independent of
 * where the subtree sits in the global grid.
 */
export function tileIndexWithinSubtree(
  scheme: SubdivisionScheme,
  coord: TileCoordinate,
  subtreeRootLevel: number,
): number {
  assertCoordinate(scheme, coord);
  if (!isIndex(subtreeRootLevel)) {
    throw new Error('implicit tiling: subtreeRootLevel must be a non-negative integer.');
  }
  const depth = coord.level - subtreeRootLevel;
  if (depth < 0) {
    throw new Error(
      `implicit tiling: level ${coord.level} is above the subtree root level ${subtreeRootLevel}.`,
    );
  }
  const n = CHILD_COUNT[scheme];
  // Tiles in levels 0..depth-1 of the subtree: (n^depth - 1) / (n - 1).
  const above = (n ** depth - 1) / (n - 1);
  const mask = 2 ** depth - 1;
  const local: TileCoordinate =
    scheme === 'QUADTREE'
      ? { level: depth, x: coord.x % (mask + 1), y: coord.y % (mask + 1) }
      : {
          level: depth,
          x: coord.x % (mask + 1),
          y: coord.y % (mask + 1),
          z: (coord.z as number) % (mask + 1),
        };
  const index = above + mortonIndex(scheme, local);
  if (!Number.isSafeInteger(index)) {
    throw new Error('implicit tiling: the subtree tile index is not an exact safe integer.');
  }
  return index;
}

/**
 * How a subtree states availability: either one constant for every tile it
 * covers, or a bitstream with one bit per tile, LSB-first within each byte.
 */
export type Availability =
  | { readonly constant: 0 | 1; readonly length?: number }
  | { readonly bitstream: Uint8Array; readonly length?: number };

/**
 * Whether the tile at `index` is available.
 *
 * An index outside the range the availability actually covers throws. Returning
 * false there would present a real tile as missing, which reads downstream as a
 * hole in the data rather than as the addressing bug it is.
 */
export function isAvailable(availability: Availability, index: number): boolean {
  if (!isIndex(index)) {
    throw new Error('implicit tiling: an availability index must be a non-negative integer.');
  }
  if ('bitstream' in availability) {
    const bits = availability.length ?? availability.bitstream.length * 8;
    if (bits > availability.bitstream.length * 8) {
      throw new Error('implicit tiling: the declared availability length exceeds the bitstream.');
    }
    if (index >= bits) {
      throw new Error(`implicit tiling: availability index ${index} is outside the ${bits} tiles covered.`);
    }
    const byte = availability.bitstream[index >> 3] as number;
    return ((byte >> (index & 7)) & 1) === 1;
  }
  if (availability.length !== undefined && index >= availability.length) {
    throw new Error(
      `implicit tiling: availability index ${index} is outside the ${availability.length} tiles covered.`,
    );
  }
  return availability.constant === 1;
}

/**
 * The bounding volume of one child under implicit subdivision, exactly.
 *
 * `childIndex` follows the same Morton order as `childCoordinates`:
 * index = dx + 2*dy + 4*dz. QUADTREE halves x and y and leaves z whole; OCTREE
 * halves all three. A volume kind with no exact halving — a sphere, whose
 * eighths are not spheres — returns null instead of an approximation, because a
 * bounding volume that is merely close is no longer a bound.
 */
export function subdivideBoundingVolume(
  scheme: SubdivisionScheme,
  parentVolume: BoundingVolume,
  childIndex: number,
): BoundingVolume | null {
  const count = CHILD_COUNT[scheme];
  if (!isIndex(childIndex) || childIndex >= count) {
    throw new Error(`implicit tiling: childIndex must be an integer in 0..${count - 1}.`);
  }
  const dx = childIndex & 1;
  const dy = (childIndex >> 1) & 1;
  const dz = scheme === 'OCTREE' ? (childIndex >> 2) & 1 : 0;
  // -1 for the low half, +1 for the high half.
  const sx = dx * 2 - 1;
  const sy = dy * 2 - 1;
  const sz = dz * 2 - 1;

  const { box, region } = parentVolume;
  if (box) {
    const u = [box[3] as number, box[4] as number, box[5] as number].map((v) => v / 2);
    const v = [box[6] as number, box[7] as number, box[8] as number].map((c) => c / 2);
    const w =
      scheme === 'OCTREE'
        ? [box[9] as number, box[10] as number, box[11] as number].map((c) => c / 2)
        : [box[9] as number, box[10] as number, box[11] as number];
    const centre = [0, 1, 2].map((i) => {
      const base = (box[i] as number) + sx * (u[i] as number) + sy * (v[i] as number);
      return scheme === 'OCTREE' ? base + sz * (w[i] as number) : base;
    });
    return { box: [...centre, ...u, ...v, ...w] };
  }

  if (region) {
    const [west, south, east, north, minH, maxH] = region as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const midLon = (west + east) / 2;
    const midLat = (south + north) / 2;
    const midH = (minH + maxH) / 2;
    return {
      region: [
        dx === 0 ? west : midLon,
        dy === 0 ? south : midLat,
        dx === 0 ? midLon : east,
        dy === 0 ? midLat : north,
        scheme === 'OCTREE' && dz === 1 ? midH : minH,
        scheme === 'OCTREE' && dz === 0 ? midH : maxH,
      ],
    };
  }

  // A sphere (or an unknown kind) has no exact implicit subdivision.
  return null;
}

/** The geometric error at a level: the root error halved once per level. */
export function geometricErrorForLevel(rootGeometricError: number, level: number): number {
  if (!Number.isFinite(rootGeometricError) || rootGeometricError < 0) {
    throw new Error('implicit tiling: rootGeometricError must be a finite non-negative number.');
  }
  if (!isIndex(level)) throw new Error('implicit tiling: level must be a non-negative integer.');
  return rootGeometricError / 2 ** level;
}
