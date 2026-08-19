/**
 * contourOverlayPlacement.ts
 *
 * The PURE half of drawing analysed contours in the 3D scene: which vertical
 * axis the overlay buffers must be built for, and where the resulting object
 * sits. No three.js here, so the part that is easy to get silently wrong — the
 * frame — is unit-tested in Node; `ContourOverlay` is the thin binding that
 * uploads the buffers.
 *
 * WHY A FRAME DECISION EXISTS AT ALL. Contours are computed in the canonical
 * Z-up survey frame (the terrain gather rotates Y-up sources first — see
 * `terrain/canonicalFrame.ts`), but the scene draws each cloud in its OWN
 * source frame: a LAS/LAZ/E57 cloud is Z-up, a phone-scan mesh (glTF/OBJ/PLY)
 * is Y-up. So the overlay has to be placed into the frame of the scan it
 * describes, not into a fixed one.
 *
 * The trap this module exists to close: for a Y-up scan it is tempting to "just
 * put the elevation in Y" (`(x, y, z) → (x, z, y)`). That is a REFLECTION. It
 * mirrors the northing, so every contour draws on the wrong side of the scan —
 * wrong in a way that still looks like a contour map, because the lines
 * themselves are real. The correct inverse is the rotation
 * `(x, y, z) → (x, z, −y)` (`canonicalZUpToYUp`). The overlay gets that by
 * BUILDING its buffers with `verticalAxis: 'y'` AND `negateNorthing: true` —
 * both, since the axis choice alone is the reflection. `overlayBufferParamsFor`
 * below is the one place that pairing is decided, so a caller cannot take half
 * of it.
 */

import type { OverlayVerticalAxis } from '../terrain/contour/contourOverlayGeometry';
import { isZUpFormat } from '../io/sniffFormat';
import type { SourceFormat } from '../io/sniffFormat';

/**
 * The scene vertical axis for a scan's source format: 'z' for the survey
 * formats (LAS/LAZ/XYZ/E57/PCD/PTX/PTS), 'y' for the mesh formats the scene
 * draws Y-up. Mirrors the axis the Viewer already colours elevation by, so an
 * overlay can never disagree with the cloud it is drawn over.
 */
export function overlayVerticalAxisFor(format: SourceFormat): OverlayVerticalAxis {
  return isZUpFormat(format) ? 'z' : 'y';
}

/**
 * The buffer-build parameters for a scan's format: the vertical axis AND the
 * northing sign, together.
 *
 * They are returned as one object on purpose. `verticalAxis: 'y'` on its own is
 * the reflection described above; it is only a rotation when paired with
 * `negateNorthing: true`. Handing callers the pair — rather than two functions
 * they must remember to call together — is what makes the mirrored-contour bug
 * unreachable from the wiring.
 */
export function overlayBufferParamsFor(format: SourceFormat): {
  readonly verticalAxis: OverlayVerticalAxis;
  readonly negateNorthing: boolean;
} {
  const verticalAxis = overlayVerticalAxisFor(format);
  return { verticalAxis, negateNorthing: verticalAxis === 'y' };
}

/**
 * The scene position for the overlay object: the same render-origin offset the
 * cloud's own mesh carries, so the contours sit exactly over the terrain they
 * were derived from rather than at the world origin.
 *
 * `null`/absent origin means the cloud is not recentred, so the overlay sits at
 * the scene origin too.
 */
export function overlayScenePosition(
  renderOrigin: readonly [number, number, number] | null | undefined,
): [number, number, number] {
  if (!renderOrigin) return [0, 0, 0];
  return [renderOrigin[0], renderOrigin[1], renderOrigin[2]];
}

/**
 * Lift the lines slightly along the scene's vertical axis so they read ON the
 * surface instead of z-fighting the points that generated them. Returns the
 * per-axis offset to add to the object's position.
 *
 * The offset is a DISPLAY nudge only: it never changes the contour elevations
 * the geometry, the readouts, or any export carry.
 */
export function overlayHeightOffsetVector(
  axis: OverlayVerticalAxis,
  heightOffset: number,
): [number, number, number] {
  const h = Number.isFinite(heightOffset) ? heightOffset : 0;
  return axis === 'y' ? [0, h, 0] : [0, 0, h];
}
