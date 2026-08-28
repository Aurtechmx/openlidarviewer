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
 * A surface normal through the transform's linear part, as a unit vector.
 *
 * A normal is not a direction that rides the linear part the way a box half-axis
 * does. Under a non-uniform or sheared linear map the plane a normal is
 * perpendicular to is skewed, and applying the same matrix to the normal leaves
 * it no longer perpendicular to that plane. The 3D Tiles specification (and every
 * graphics text on the subject) fixes this by transforming a normal with the
 * inverse-transpose of the upper-left 3x3, then renormalising: the inverse
 * cancels the skew and the transpose puts it back in the normal's covector space.
 *
 * The inverse-transpose is the cofactor matrix of the 3x3 divided by its
 * determinant. Dividing by the SIGNED determinant matters: a reflection
 * (negative determinant) must flip the normal, and only the signed divide does
 * that, which renormalising afterwards preserves rather than erases.
 *
 * Degenerate case: a 3x3 whose determinant is zero collapses a dimension and has
 * no inverse. Rather than emit NaN, the direction is carried through the plain
 * linear part and normalised, which is the best available answer for a transform
 * that is not supposed to occur on a real tile. A zero-length result (a normal
 * the linear part sends to the origin) is returned as written.
 */
export function transformNormal(m: Mat4, v: Vec3): [number, number, number] {
  // Upper-left 3x3, column-major: a3[col][row] = m[col * 4 + row].
  const a = m[0]!, b = m[1]!, c = m[2]!; // column 0
  const d = m[4]!, e = m[5]!, f = m[6]!; // column 1
  const g = m[8]!, h = m[9]!, i = m[10]!; // column 2

  // Cofactor matrix of the 3x3. `cof[row][col]` is the signed minor with that
  // row and column struck out; the cofactor matrix (not its transpose) is the
  // inverse-transpose once divided by the determinant.
  const cof00 = e * i - f * h;
  const cof01 = -(b * i - c * h);
  const cof02 = b * f - c * e;
  const cof10 = -(d * i - f * g);
  const cof11 = a * i - c * g;
  const cof12 = -(a * f - c * d);
  const cof20 = d * h - e * g;
  const cof21 = -(a * h - b * g);
  const cof22 = a * e - b * d;

  const det = a * cof00 + d * cof01 + g * cof02;
  const [x, y, z] = v;

  if (!Number.isFinite(det) || det === 0) {
    // No inverse. Fall back to the plain linear part, normalised.
    return normalizeOrZero(
      a * x + d * y + g * z,
      b * x + e * y + h * z,
      c * x + f * y + i * z,
    );
  }

  // (inverse-transpose) · v = (cofactor / det) · v. Row `r` of the cofactor
  // matrix is (cof[r][0], cof[r][1], cof[r][2]).
  const nx = (cof00 * x + cof01 * y + cof02 * z) / det;
  const ny = (cof10 * x + cof11 * y + cof12 * z) / det;
  const nz = (cof20 * x + cof21 * y + cof22 * z) / det;
  return normalizeOrZero(nx, ny, nz);
}

/** Normalise a vector, returning it unchanged when its length is zero. */
function normalizeOrZero(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z);
  if (length === 0 || !Number.isFinite(length)) return [x, y, z];
  return [x / length, y / length, z / length];
}

/**
 * The largest scaling factor of the linear part: its spectral norm, i.e. the
 * largest singular value of the upper-left 3x3.
 *
 * This is the true maximum stretch the transform applies to any direction, and
 * the quantity the specification's geometric-error scaling means. The longest
 * of the three transformed basis vectors (the previous column-norm form) equals
 * it only for a rotation composed with an axis-aligned scale; for a general
 * affine or shear it UNDER-reports. The classic witness is the shear whose
 * upper-left 3x3 is [[1,1,0],[0,1,0],[0,0,1]]: its column norms top out at
 * sqrt(2) ~= 1.414, but its true largest singular value is (1+sqrt(5))/2
 * ~= 1.618. Under-reporting shrinks bounding spheres (culling geometry that is
 * really inside) and under-scales 1.1 geometric error (refining too late), so
 * the maximum here must never fall below the spectral norm.
 *
 * Computed as sqrt of the largest eigenvalue of A^T A, a symmetric positive-
 * semidefinite 3x3, via the closed-form trigonometric eigenvalue solution
 * (Smith 1961). Singular values are transpose-invariant, so column-major versus
 * row-major storage of the 3x3 does not change the result.
 */
export function largestScale(m: Mat4): number {
  // Columns of the upper-left 3x3 (column-major: m[col*4 + row]).
  const c0x = m[0]!, c0y = m[1]!, c0z = m[2]!;
  const c1x = m[4]!, c1y = m[5]!, c1z = m[6]!;
  const c2x = m[8]!, c2y = m[9]!, c2z = m[10]!;

  // A^T A is symmetric; its entries are the dot products of the columns.
  const a = c0x * c0x + c0y * c0y + c0z * c0z; // (0,0)
  const b = c1x * c1x + c1y * c1y + c1z * c1z; // (1,1)
  const c = c2x * c2x + c2y * c2y + c2z * c2z; // (2,2)
  const d = c0x * c1x + c0y * c1y + c0z * c1z; // (0,1)
  const e = c0x * c2x + c0y * c2y + c0z * c2z; // (0,2)
  const f = c1x * c2x + c1y * c2y + c1z * c2z; // (1,2)

  const maxEigenvalue = largestSymmetricEigenvalue3x3(a, b, c, d, e, f);
  // Clamp away a tiny negative that rounding can produce for a near-singular A.
  return Math.sqrt(Math.max(0, maxEigenvalue));
}

/**
 * Largest eigenvalue of the symmetric 3x3
 *   [ a d e ]
 *   [ d b f ]
 *   [ e f c ]
 * by the closed-form trigonometric method (Smith 1961). All three eigenvalues
 * are real; only the largest is returned.
 */
function largestSymmetricEigenvalue3x3(
  a: number, b: number, c: number, d: number, e: number, f: number,
): number {
  const p1 = d * d + e * e + f * f;
  if (p1 === 0) {
    // Already diagonal: the eigenvalues are the diagonal entries.
    return Math.max(a, b, c);
  }
  const q = (a + b + c) / 3;
  const p2 = (a - q) ** 2 + (b - q) ** 2 + (c - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  // B = (A - qI) / p; det(B) / 2 lies in [-1, 1] up to rounding.
  const ba = (a - q) / p, bb = (b - q) / p, bc = (c - q) / p;
  const bd = d / p, be = e / p, bf = f / p;
  const detB =
    ba * (bb * bc - bf * bf) -
    bd * (bd * bc - bf * be) +
    be * (bd * bf - bb * be);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  // eig1 = q + 2p cos(phi) is the largest of the three.
  return q + 2 * p * Math.cos(phi);
}

/** A tile's geometric error under its cumulative transform. */
export function transformGeometricError(m: Mat4, geometricError: number): number {
  return geometricError * largestScale(m);
}

/**
 * Whether a tileset's geometric error is scaled by the tile transform.
 *
 * The two versions disagree, and the difference is not cosmetic: in 3D Tiles 1.0
 * the tile transform does NOT apply to `geometricError`, while 1.1 scales it by
 * the transform's largest scaling factor. Applying the 1.1 rule to a 1.0 tileset
 * with a scaling root transform refines at the wrong error and mis-selects tiles.
 *
 * Only an explicit '1.0' opts out. An absent or unrecognised version defaults to
 * scaling (the 1.1 rule): overscaling the error refines earlier and never
 * under-refines, the same conservative direction the bounding volumes take, and
 * it matches the historical behaviour of this walk. In production the tileset
 * parser accepts only '1.0' or '1.1', so a served tileset always states which;
 * this default is reached only by direct calls that omit the version.
 */
export function scalesGeometricError(assetVersion: string | undefined): boolean {
  return assetVersion !== '1.0';
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
  assetVersion?: string,
): Generator<PlacedTile> {
  // 1.0 leaves geometric error unscaled; 1.1 (and the conservative default for
  // an absent version) scales it by the cumulative transform. Decided once.
  const scaleGeometricError = scalesGeometricError(assetVersion);
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
      geometricError: scaleGeometricError
        ? transformGeometricError(transform, tile.geometricError)
        : tile.geometricError,
      depth,
    };

    // Pushed in reverse so the walk yields children in authored order, which is
    // what a reader comparing against the JSON expects.
    for (let i = tile.children.length - 1; i >= 0; i--) {
      stack.push({ tile: tile.children[i]!, parent: transform, depth: depth + 1 });
    }
  }
}
