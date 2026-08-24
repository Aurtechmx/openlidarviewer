/**
 * screenSpaceError.ts — 3D Tiles screen-space error, as pure arithmetic.
 *
 * A tile carries a `geometricError` in world units: the error you accept by
 * drawing that tile instead of its children. Refinement decisions are made in
 * pixels, so the world error has to be projected onto the screen first. That
 * projection is not the same in the two cameras OLV uses.
 *
 * PERSPECTIVE. The standard 3D Tiles form:
 *
 *     ssePx = geometricError * viewportHeightPx / (2 * distance * tan(fov / 2))
 *
 * The denominator is the world height of the view frustum at `distance`, so
 * the expression is the tile error expressed as a fraction of that height and
 * then scaled to pixels.
 *
 * ORTHOGRAPHIC. OLV's Plan view is orthographic, and the perspective formula
 * is wrong there, not merely imprecise. An orthographic projection maps a
 * fixed world height onto the viewport regardless of how far away anything
 * is, so screen size does not fall off with distance and `distance` must not
 * appear in the formula at all. Using the perspective form in Plan view makes
 * near tiles refine far past what the zoom level can show and far tiles stay
 * coarse when the zoom level says they should not. The world height the
 * viewport represents is the whole of the projection:
 *
 *     ssePx = geometricError * viewportHeightPx / orthographicWorldHeight
 *
 * Zoom therefore drives refinement here: halving `orthographicWorldHeight`
 * (zooming in) doubles the SSE.
 *
 * DISTANCE 0. A camera at or inside a tile's bounding volume gives distance 0,
 * and the perspective formula divides by zero. Zero distance means the tile
 * error subtends an unbounded angle, so its screen error is infinite and the
 * tile should always refine. This module returns `Infinity` for that case
 * rather than letting the division produce `NaN` for a zero-error tile, since
 * a `NaN` compares false against every threshold and would silently stop
 * refinement exactly where the most detail is wanted. A zero `geometricError`
 * is resolved first and gives 0 in every camera: a tile with no error has no
 * screen error, whatever the geometry.
 *
 * Pure: no camera objects, no renderer types, no scheduler.
 */

/** A perspective camera, described by the numbers the SSE needs. */
export interface PerspectiveSseInput {
  /** Tile geometric error, in the same world units as `distance`. */
  readonly geometricError: number;
  /** Viewport height in pixels. */
  readonly viewportHeightPx: number;
  /** Distance from the camera to the tile's bounding volume, world units. */
  readonly distance: number;
  /** Vertical field of view, in RADIANS. */
  readonly verticalFov: number;
}

/** An orthographic camera. Note the absence of any distance. */
export interface OrthographicSseInput {
  /** Tile geometric error, in the same world units as the view height. */
  readonly geometricError: number;
  /** Viewport height in pixels. */
  readonly viewportHeightPx: number;
  /** World height the viewport spans, world units. Smaller means zoomed in. */
  readonly orthographicWorldHeight: number;
}

export type CameraSseInput =
  | ({ readonly kind: 'perspective' } & PerspectiveSseInput)
  | ({ readonly kind: 'orthographic' } & OrthographicSseInput);

/**
 * True when `geometricError` is a degenerate zero, which short-circuits every
 * camera to 0 before any division can turn it into `NaN`.
 */
function isZeroError(geometricError: number): boolean {
  return geometricError === 0;
}

/**
 * Perspective screen-space error in pixels.
 *
 * Returns `Infinity` when the geometry says the error is unbounded on screen
 * (distance 0, or a viewport/fov that cannot be projected), and 0 when the
 * tile has no error at all. Never returns `NaN`.
 */
export function perspectiveScreenSpaceError(input: PerspectiveSseInput): number {
  const { geometricError, viewportHeightPx, distance, verticalFov } = input;

  if (!Number.isFinite(geometricError) || geometricError < 0) return Infinity;
  if (isZeroError(geometricError)) return 0;

  // A viewport with no height, or a non-finite one, cannot bound the error.
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return Infinity;

  // Distance 0 (camera inside the volume) and any invalid distance: refine.
  if (!Number.isFinite(distance) || distance <= 0) return Infinity;

  // tan is only a frustum half-width for 0 < fov < PI. At or beyond PI it is
  // zero or negative and the formula stops meaning anything.
  if (!Number.isFinite(verticalFov) || verticalFov <= 0 || verticalFov >= Math.PI) {
    return Infinity;
  }

  const halfFrustumWorldHeight = Math.tan(verticalFov / 2);
  if (!(halfFrustumWorldHeight > 0) || !Number.isFinite(halfFrustumWorldHeight)) {
    return Infinity;
  }

  const sse = (geometricError * viewportHeightPx) / (2 * distance * halfFrustumWorldHeight);
  return Number.isNaN(sse) ? Infinity : sse;
}

/**
 * Orthographic screen-space error in pixels.
 *
 * `distance` is deliberately absent: see the module comment. A world height of
 * zero is a fully collapsed projection, where any error fills the screen, so
 * it yields `Infinity`.
 */
export function orthographicScreenSpaceError(input: OrthographicSseInput): number {
  const { geometricError, viewportHeightPx, orthographicWorldHeight } = input;

  if (!Number.isFinite(geometricError) || geometricError < 0) return Infinity;
  if (isZeroError(geometricError)) return 0;

  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return Infinity;
  if (!Number.isFinite(orthographicWorldHeight) || orthographicWorldHeight <= 0) {
    return Infinity;
  }

  const sse = (geometricError * viewportHeightPx) / orthographicWorldHeight;
  return Number.isNaN(sse) ? Infinity : sse;
}

/** Screen-space error for either camera, chosen by the `kind` discriminant. */
export function screenSpaceError(camera: CameraSseInput): number {
  if (camera.kind === 'orthographic') {
    return orthographicScreenSpaceError(camera);
  }
  return perspectiveScreenSpaceError(camera);
}

/**
 * Whether a tile with this screen-space error should be refined.
 *
 * `maxSse` is the quality threshold in pixels: lower means more refinement.
 * An `Infinity` error always refines. A non-finite or non-positive threshold
 * is not a usable quality setting, so nothing refines on it rather than
 * everything refining forever.
 */
export function shouldRefine(sse: number, maxSse: number): boolean {
  if (Number.isNaN(sse)) return false;
  if (!Number.isFinite(maxSse) || maxSse <= 0) return false;
  return sse > maxSse;
}
