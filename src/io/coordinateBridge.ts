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

/**
 * The one origin a scene can honestly claim, or `null` when it has none.
 *
 * Every cloud is recentred on its OWN `computeOrigin(min)`, and nothing
 * re-places a mesh by an origin delta afterwards — so two files whose origins
 * differ are already drawn in frames that do not line up. There is then no
 * single answer to "what world coordinate is local zero", and picking one
 * cloud's (the newest, the first, the streaming one) would hand its frame to
 * points that were never in it. Unanimity is the only defensible assertion:
 * agree and the scene has a frame, differ and it has none.
 *
 * This is the rule the georeference seam already applies before it will emit a
 * world file. An absolute elevation is the same kind of claim, so it answers to
 * the same gate. A cloud carrying no origin at all is an unknown frame, which
 * cannot be unanimous with anything.
 *
 * Order-independent by construction: the caller may pass clouds in any order.
 */
export function resolveSceneOrigin(
  origins: Iterable<readonly number[] | null | undefined>,
): [number, number, number] | null {
  let agreed: [number, number, number] | null = null;
  for (const o of origins) {
    if (!o || o.length < 3) return null;
    if (agreed === null) {
      agreed = [o[0], o[1], o[2]];
    } else if (agreed[0] !== o[0] || agreed[1] !== o[1] || agreed[2] !== o[2]) {
      return null; // conflicting frames — honestly no scene origin
    }
  }
  return agreed;
}
