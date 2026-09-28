/**
 * residentPositionsDigest.ts — SHA-256 over every resident position an
 * Observatory run reads.
 *
 * The digest covers the positions array the run used (local, recentred
 * Float32 coordinates), each value written as 4 little-endian IEEE 754 bytes,
 * in array order. It identifies the resident point set, not the source file:
 * a streamed source whose resident subset changes gets a different digest,
 * and two files that load to the same resident positions get the same one.
 * No whole-file hash exists in the load path, so the run record's
 * `source.sha256` stays null.
 *
 * The hash runs in fixed-size chunks through one staging buffer
 * (`IncrementalSha256`), so memory stays bounded however large the cloud is;
 * the positions are never copied whole.
 */
import { IncrementalSha256 } from '../io/heavy/incrementalSha256';

/** Float32 values staged per chunk. */
const CHUNK_VALUES = 64 * 1024;

/** Lower-case hex SHA-256 of `positions` as little-endian float32 bytes, in array order. */
export function residentPositionsDigest(positions: Float32Array): string {
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
