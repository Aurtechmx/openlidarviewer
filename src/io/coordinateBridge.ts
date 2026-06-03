/**
 * Bridges large georeferenced coordinates (e.g. UTM easting/northing in the
 * hundreds-of-thousands to millions) into the small, GPU-friendly local
 * coordinate space three.js expects.
 *
 * The viewer keeps geometry in Float32Array buffers. A bare UTM coordinate
 * like 4_100_876.789 cannot be represented exactly in float32 — the mantissa
 * runs out of bits and the value snaps to the nearest ~0.5 m grid. The fix is
 * to subtract a per-cloud integer `origin` while still in double precision,
 * THEN downcast the small residual to float32.
 */

/**
 * Pick a local-space origin for a cloud given its (double-precision) minimum
 * bounds. Each component is floored to an integer so the origin is stable and
 * easy to reason about.
 */
export function computeOrigin(min: number[]): [number, number, number] {
  return [Math.floor(min[0]), Math.floor(min[1]), Math.floor(min[2])];
}

/**
 * Subtract `origin` from interleaved xyz coordinates and return the result as
 * a Float32Array suitable for a three.js BufferGeometry.
 *
 * Precision note: the subtraction is done in Float64 (the input array is
 * Float64Array and `origin` holds plain JS numbers, i.e. doubles). The f32
 * downcast happens ONLY when each residual is written into the Float32Array
 * below. Downcasting the large UTM value first and subtracting afterwards
 * would discard sub-metre detail before we ever got to keep it — so the
 * order (subtract in f64, then narrow to f32) is load-bearing.
 */
export function recenter(coords: Float64Array, origin: [number, number, number]): Float32Array {
  const out = new Float32Array(coords.length);
  const [ox, oy, oz] = origin;
  // Step three at a time so the x/y/z origin is applied without a per-element
  // modulo. The buffer is interleaved xyz, so its length is a multiple of 3.
  // Each f64 subtraction narrows to f32 only on assignment into `out`.
  for (let i = 0; i < coords.length; i += 3) {
    out[i] = coords[i] - ox;
    out[i + 1] = coords[i + 1] - oy;
    out[i + 2] = coords[i + 2] - oz;
  }
  return out;
}
