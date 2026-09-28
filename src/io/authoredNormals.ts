/**
 * authoredNormals.ts
 *
 * Copies the per-point normals a file declares into the cloud's normal
 * channel. Nothing is estimated here: a file without normals yields none.
 *
 * The channel is all-or-nothing. A normal has to be finite and unit length
 * (within `UNIT_TOLERANCE`, which admits the quantisation of an 8-bit or
 * oct-encoded normal) for the channel to be kept. One point with an
 * unusable normal drops the whole channel rather than the point, because
 * a normal is a presentation attribute and must never cost a coordinate.
 *
 * Pure: runs inside the parse worker.
 */

const UNIT_TOLERANCE = 0.02;

/**
 * @param src    Interleaved source values, `stride` components per point.
 * @param count  Points to read.
 * @param stride Components per point in `src` (3 for xyz, more when padded).
 * @returns A packed xyz Float32Array, or `undefined` when any normal is
 *          missing, non-finite or not unit length.
 */
export function authoredNormals(
  src: ArrayLike<number> | null | undefined,
  count: number,
  stride = 3,
): Float32Array | undefined {
  if (!src || stride < 3 || src.length < count * stride) return undefined;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = src[i * stride];
    const y = src[i * stride + 1];
    const z = src[i * stride + 2];
    const len = Math.hypot(x, y, z);
    if (!Number.isFinite(len) || Math.abs(len - 1) > UNIT_TOLERANCE) return undefined;
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}
