import type { BoxBounds } from '../measure/geometry';

/** About one Float32 step (2^-23) with a safety factor of two. */
const FLOAT32_MARGIN = 2 ** -22;

/**
 * A layer's own bounds moved into the shared project frame, which is the frame
 * the clip box and its kept-count work in. `offset` is the layer's placement
 * (`Viewer.layerProjectOffset`); null or all zero means the layer is unplaced
 * and its bounds are returned as they are.
 *
 * Positions are held as Float32 after the offset is added, so a point on the
 * edge of the exact Float64 sum can round just outside it. A placed scan's box
 * is widened by about one Float32 step of its coordinate (under a millimetre
 * at a 2 km offset) so the fit keeps every point of the scan.
 */
export function fitBoundsInProject(
  bounds: BoxBounds | null,
  offset: readonly [number, number, number] | null,
): BoxBounds | null {
  if (!bounds) return null;
  if (!offset || (offset[0] === 0 && offset[1] === 0 && offset[2] === 0)) return bounds;
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const lo = bounds.min[a] + offset[a];
    const hi = bounds.max[a] + offset[a];
    const margin = Math.max(Math.abs(lo), Math.abs(hi)) * FLOAT32_MARGIN;
    min[a] = lo - margin;
    max[a] = hi + margin;
  }
  return { min, max };
}

/**
 * Fit to scan over every visible layer: the viewer's merged, placed bounds
 * (`[minx, miny, minz, maxx, maxy, maxz]`, project frame) as a box, widened by
 * about one Float32 step of each coordinate for the same reason as
 * {@link fitBoundsInProject} (a placed point can round just outside the exact
 * sum). Null with nothing visible.
 */
export function fitMergedBounds(merged: readonly number[] | null): BoxBounds | null {
  if (!merged || merged.length < 6 || !merged.every(Number.isFinite)) return null;
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const lo = merged[a];
    const hi = merged[3 + a];
    const margin = Math.max(Math.abs(lo), Math.abs(hi)) * FLOAT32_MARGIN;
    min[a] = lo - margin;
    max[a] = hi + margin;
  }
  return { min, max };
}
