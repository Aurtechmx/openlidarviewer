/**
 * pointsSha256.ts: SHA-256 over a point set, as little-endian float32 bytes.
 *
 * Each value of `positions` is written as 4 little-endian IEEE 754 bytes, in
 * array order, and hashed in fixed-size chunks through one staging buffer
 * (`IncrementalSha256`), so memory stays bounded and the array is never copied
 * whole. The same points in the same order always give the same digest.
 *
 * Export provenance records this as the analysis-input digest: the exact
 * points an analysis read after filters, Withheld exclusion and clipping.
 */
import { IncrementalSha256 } from '../io/heavy/incrementalSha256';

/** Float32 values staged per chunk. */
const CHUNK_VALUES = 64 * 1024;

/** Lower-case hex SHA-256 of `positions` as little-endian float32 bytes, in array order. */
export function pointsSha256(positions: ArrayLike<number>): string {
  const hasher = new IncrementalSha256();
  const stage = new ArrayBuffer(Math.min(CHUNK_VALUES, positions.length) * 4);
  const view = new DataView(stage);
  const bytes = new Uint8Array(stage);
  for (let i = 0; i < positions.length; i += CHUNK_VALUES) {
    const take = Math.min(CHUNK_VALUES, positions.length - i);
    for (let j = 0; j < take; j++) view.setFloat32(j * 4, positions[i + j]!, true);
    hasher.update(take === CHUNK_VALUES ? bytes : bytes.subarray(0, take * 4));
  }
  return hasher.digestHex();
}
