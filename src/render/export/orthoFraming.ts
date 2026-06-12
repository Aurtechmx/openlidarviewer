/**
 * orthoFraming.ts
 *
 * Pure framing math for the Studio's georeferenced TOP-DOWN orthographic
 * render: AABB footprint → camera frustum, camera pose, raster pixel size,
 * and the world rectangle the frustum covers. Extracted from
 * `Viewer._renderFramedTopDown` (v0.4.5, workplan C4) so the contract the
 * `.pgw` world file depends on — "the extent handed to
 * `buildWorldFileText` is EXACTLY the rectangle the camera framed" — is a
 * unit-testable equation instead of inline GPU-adjacent code.
 *
 * The extent is not computed from the AABB twice: it is DERIVED from the
 * camera pose + frustum via {@link orthoFrustumWorldRect}, so the world
 * file can never describe a different rectangle than the one rendered —
 * any future change to the framing automatically propagates to the
 * sidecar.
 *
 * No three.js, no DOM — the Viewer builds its `THREE.OrthographicCamera`
 * from the returned numbers.
 */

import type { OrthoExtent } from './pngWorldFile';

/** Default raster width when the caller does not request one. */
export const DEFAULT_FRAMED_EXPORT_WIDTH_PX = 2048;

/** Orthographic frustum half-planes plus clip range (camera-local units). */
export interface OrthoFrustum {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly near: number;
  readonly far: number;
}

/** What a framed top-down render needs, all derived from one AABB. */
export interface TopDownFraming {
  /**
   * World rectangle the frustum covers — feed straight into the world
   * file. Derived from `camera` + `frustum`, never recomputed from the
   * AABB (see module doc).
   */
  readonly extent: OrthoExtent;
  /** Output raster size. Width honours the request; height keeps pixels square. */
  readonly widthPx: number;
  readonly heightPx: number;
  readonly frustum: OrthoFrustum;
  /**
   * Camera pose: positioned above the footprint centre, looking straight
   * down (-Z; render space is Z-up) at `lookZ`, with +Y up so the raster
   * is north-up — the orientation the world file asserts.
   */
  readonly camera: { readonly x: number; readonly y: number; readonly z: number; readonly lookZ: number };
}

/**
 * The camera-frustum → world-rectangle equation: an orthographic camera at
 * (x, y) looking straight down covers exactly its frustum planes offset by
 * its own position. This is the rectangle the rendered pixels span, so it
 * is what the `.pgw` per-pixel scale must divide.
 */
export function orthoFrustumWorldRect(
  camera: { readonly x: number; readonly y: number },
  frustum: Pick<OrthoFrustum, 'left' | 'right' | 'top' | 'bottom'>,
): OrthoExtent {
  return {
    minX: camera.x + frustum.left,
    maxX: camera.x + frustum.right,
    minY: camera.y + frustum.bottom,
    maxY: camera.y + frustum.top,
  };
}

/**
 * Plan a top-down orthographic frame of the given local-space AABB
 * (`[minX, minY, minZ, maxX, maxY, maxZ]`).
 *
 *   - Frustum covers EXACTLY the XY footprint (centred half-extents), so
 *     `extent` maps 1:1 onto the raster — the exactness that makes the
 *     world file's per-pixel scale correct.
 *   - Camera sits one Z-extent above the top of the cloud (`maxZ + dz`)
 *     with `far = 4·dz + 1` so the whole depth range is inside the clip
 *     volume with margin; `near` stays a small positive epsilon as
 *     required by depth-buffer math.
 *   - Output width is the request (default {@link DEFAULT_FRAMED_EXPORT_WIDTH_PX}),
 *     height follows the footprint aspect so pixels stay square to within
 *     the 1 px rounding the world file's independent X/Y scales absorb
 *     exactly. Both clamp to ≥ 2 px so a sliver footprint still rasterises.
 *
 * Returns null for a degenerate footprint (zero/negative/NaN XY extent) —
 * the caller falls back to the non-georeferenced view capture.
 */
export function frameTopDownOrtho(
  aabb: readonly [number, number, number, number, number, number],
  widthPx?: number,
): TopDownFraming | null {
  const [minX, minY, minZ, maxX, maxY, maxZ] = aabb;
  const fpW = maxX - minX;
  const fpH = maxY - minY;
  // NaN fails both comparisons, so a malformed AABB lands here too.
  if (!(fpW > 1e-6) || !(fpH > 1e-6)) return null;

  const dz = Math.max(1e-6, maxZ - minZ);
  const camera = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: maxZ + dz,
    lookZ: (minZ + maxZ) / 2,
  };
  const frustum: OrthoFrustum = {
    left: -fpW / 2,
    right: fpW / 2,
    top: fpH / 2,
    bottom: -fpH / 2,
    near: 0.01,
    far: dz * 4 + 1,
  };
  const outW = Math.max(2, Math.round(widthPx ?? DEFAULT_FRAMED_EXPORT_WIDTH_PX));
  const outH = Math.max(2, Math.round(outW * (fpH / fpW)));
  return {
    extent: orthoFrustumWorldRect(camera, frustum),
    widthPx: outW,
    heightPx: outH,
    frustum,
    camera,
  };
}
