/**
 * orthoProjection.ts — the pure maths behind a true orthographic camera.
 *
 * Split out of Viewer so the projection geometry is unit-tested in Node, with
 * no three.js and no render graph: the frustum that fits a scene, the constant
 * point size that replaces perspective attenuation, and the migration that
 * reads a legacy "near-orthographic" saved view (a 2° perspective lens) as a
 * real orthographic one. The Viewer consumes these; it never re-derives them.
 *
 * This is increment 1 of the orthographic-camera work (see
 * docs — the ortho camera + orientation cube design). Wiring the second camera,
 * the render pass, picking, EDL and saved views onto these follows.
 */

/** Which projection the camera presents. */
export type ProjectionMode = 'perspective' | 'orthographic';

/** An orthographic frustum's half-width and half-height, in world units. */
export interface OrthoHalfExtents {
  readonly halfW: number;
  readonly halfH: number;
}

/**
 * The half-extents of an orthographic frustum that fits a sphere of `radius`
 * at viewport `aspect` (width / height), with an optional padding factor.
 *
 * The SHORTER viewport axis bounds the sphere, so it always fits whichever way
 * the window is shaped: in landscape (aspect ≥ 1) the height is the tight axis
 * and the width stretches by the aspect; in portrait the roles swap. A
 * non-finite or non-positive aspect falls back to square (1), and a degenerate
 * radius is floored so the frustum never collapses to a plane.
 */
export function orthoHalfExtents(radius: number, aspect: number, pad = 1): OrthoHalfExtents {
  const r = Math.max(radius, 1e-6) * (pad > 0 ? pad : 1);
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return a >= 1 ? { halfW: r * a, halfH: r } : { halfW: r, halfH: r / a };
}

/**
 * The pixel size of a point under orthographic projection.
 *
 * There is no perspective divide, so a point does not shrink with distance —
 * every point is the same size. It does scale with zoom: a point is `basePx`
 * pixels when the scene is framed (`fitHalfH`), and grows as you zoom in and
 * the frustum's half-height (`curHalfH`) shrinks below the fit. The result is
 * clamped to the same `[minPx, maxPx]` band the perspective path uses, so a
 * hard zoom cannot inflate points without bound.
 */
export function orthoPointPixels(
  basePx: number,
  fitHalfH: number,
  curHalfH: number,
  minPx: number,
  maxPx: number,
): number {
  const scale = curHalfH > 1e-9 ? fitHalfH / curHalfH : 1;
  return Math.min(Math.max(basePx * scale, minPx), maxPx);
}

/**
 * Read a saved view's stored field of view as a projection mode.
 *
 * Before a real orthographic camera existed, "orthographic" was a 2° perspective
 * lens, and a saved view recorded it as `fov ≈ orthoFovDeg`. Such a view must
 * restore as orthographic, not as a 2° perspective that no live control can
 * reproduce. Any other stored fov — including its absence — is perspective.
 */
export function projectionFromLegacyFov(
  fov: number | undefined,
  orthoFovDeg: number,
): ProjectionMode {
  if (fov == null || !Number.isFinite(fov)) return 'perspective';
  return Math.abs(fov - orthoFovDeg) < 0.5 ? 'orthographic' : 'perspective';
}
