/**
 * annotationMapProjection.ts
 *
 * Pure (no pdf-lib, no DOM) placement maths for annotation markers on the
 * contour map sheet. Kept out of {@link ./mapSheetPdf} so the ONE thing that can
 * plot a marker in the wrong place — the coordinate-frame conversion — is
 * unit-testable on its own, with page coordinates a test can compute by hand.
 *
 * ── THE COORDINATE-FRAME PROBLEM (read before touching this) ────────────────
 * The map draws `input.model` geometry and sizes its `bbox` in the CANONICAL
 * Z-up survey frame. That frame is produced by `Viewer.gatherTerrainPositions`,
 * which rotates the source buffer into "X east / Y north / Z up" BEFORE the
 * terrain pipeline reads it (see `terrain/canonicalFrame.ts`): a Z-up source is
 * left untouched, a Y-up source (phone-scan mesh: PLY/OBJ/glTF) is rotated
 * `(x, y, z) → (x, -z, y)`. So the contour model's 2D coordinates are the
 * canonical HORIZONTAL axes.
 *
 * An annotation's `localPosition`, by contrast, lives in the RAW scene/render
 * frame — the same buffer the cloud is drawn from, the frame the marker was
 * picked in — BEFORE that rotation. To land a marker on the contour it was
 * placed over, apply the SAME scene→canonical rotation to its horizontal
 * components:
 *   - z-up scene: map (x, y) = (local.x,  local.y)   // identity
 *   - y-up scene: map (x, y) = (local.x, -local.z)   // canonical X, Y
 * The scene's up-axis is exactly the gather's `sourceUpAxis`, threaded through
 * so this can never disagree with the frame the contours were built in (using
 * the source FORMAT's nominal axis instead would misplace a Z-up-authored PLY,
 * which the gather detects as Z-up but the format table calls Y-up).
 *
 * We convert `localPosition`, NEVER `worldPosition`: the map draws geometry in
 * the LOCAL (origin-shifted) frame and only adds `worldOrigin` back for graticule
 * LABELS, so `bbox` is local and a marker must be too. Adding the world origin
 * would push every marker off the sheet by the whole recentre offset.
 */

/** Which axis is vertical in the RAW scene frame the annotation was picked in. */
export type SceneUpAxis = 'z' | 'y';

/** A ground-plan point in the map (contour-model) frame. */
export interface MapXY {
  readonly x: number;
  readonly y: number;
}

/** The map's ground extent — the contour model's bbox. */
export interface MapBBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * The fit transform the map uses: page point = (ox, oy) + (map - min) * scale.
 * Matches the `t = fitTransform(bbox, inner)` the sheet already builds, so the
 * marker projection reuses the exact same transform as the contour geometry.
 */
export interface MapFitTransform {
  readonly ox: number;
  readonly oy: number;
  readonly scale: number;
}

/**
 * Convert an annotation's raw-scene local position into the map (contour) frame.
 * See the file header for the frame reasoning. Only the two horizontal
 * components survive; the elevation drops out of a ground plan.
 */
export function annotationToMapXY(
  local: { readonly x: number; readonly y: number; readonly z: number },
  sceneUpAxis: SceneUpAxis,
): MapXY {
  return sceneUpAxis === 'y' ? { x: local.x, y: -local.z } : { x: local.x, y: local.y };
}

/** A projected marker: its y-up page point and whether it falls on the map. */
export interface ProjectedAnnotation {
  readonly pageX: number;
  readonly pageY: number;
  /**
   * True when the map-frame point is within the model's bbox (edges inclusive).
   * A marker outside the bbox is omitted from the map — the sheet notes it is
   * still listed in the description table so nothing is silently dropped.
   */
  readonly insideBbox: boolean;
}

/**
 * Project one annotation to its y-up page point through the SAME fit transform
 * the contour geometry uses, and report whether it lands on the map. The bbox
 * test is inclusive of the edges: an annotation exactly on the map border is a
 * valid on-map marker, not an off-map one.
 */
export function projectAnnotationToPage(
  local: { readonly x: number; readonly y: number; readonly z: number },
  sceneUpAxis: SceneUpAxis,
  bbox: MapBBox,
  t: MapFitTransform,
): ProjectedAnnotation {
  const m = annotationToMapXY(local, sceneUpAxis);
  const insideBbox =
    m.x >= bbox.minX && m.x <= bbox.maxX && m.y >= bbox.minY && m.y <= bbox.maxY;
  return {
    pageX: t.ox + (m.x - bbox.minX) * t.scale,
    pageY: t.oy + (m.y - bbox.minY) * t.scale,
    insideBbox,
  };
}
