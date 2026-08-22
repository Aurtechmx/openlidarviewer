/**
 * profilePath.ts
 *
 * SVG path assembly for the terrain-profile line, shared by the panel chart
 * (`MeasurePanel.renderProfileChart`) and the profile sheet
 * (`profilePdf.buildProfilePdf`) so both draw the same geometry from the same
 * samples.
 *
 * The path is a straight polyline between adjacent samples. Every point of an
 * emitted segment is a convex combination of that segment's two endpoints, so
 * no drawn height lies outside the range of the two stations bracketing it.
 *
 * This replaces a uniform Catmull-Rom spline emitted as cubic Beziers. That
 * curve interpolated every sample but was not bounded between them. Measured
 * on the emitted path: stations [0, 1, 1, 0] reached 1.1275 between two
 * stations that both read exactly 1, and stations [0, 0, 0, 1] reached
 * -0.0756 inside a run of zeros. Neither height is in the data.
 *
 * Callers split their samples into runs before calling. A non-finite sample
 * ends a run, so a coverage gap stays a break in the drawn line and is never
 * bridged.
 *
 * Pure string assembly: no DOM, no I/O, no dependencies.
 */

/** Decimal places every emitted coordinate carries. */
const COORD_DECIMALS = 2;

/**
 * Build the SVG path for one contiguous run of samples.
 *
 * Emits `M` followed by one `L` per subsequent point. An empty run emits the
 * empty string; a single point emits a bare `M`, which draws nothing and
 * matches the previous builders' handling of a one-sample run.
 *
 * Coordinates are caller-space: the panel passes viewBox units (y down, the
 * elevation axis already inverted), the PDF passes points relative to the plot
 * origin it hands `drawSvgPath`.
 */
export function profilePolylinePath(
  pts: ReadonlyArray<{ x: number; y: number }>,
): string {
  const n = pts.length;
  if (n === 0) return '';
  const f = (v: number): string => v.toFixed(COORD_DECIMALS);
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < n; i++) d += ` L ${f(pts[i].x)} ${f(pts[i].y)}`;
  return d;
}
