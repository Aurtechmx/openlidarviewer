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
 * The bytes and order are those of `pointsSha256`.
 */
import { pointsSha256 } from '../science/pointsSha256';

/** Lower-case hex SHA-256 of `positions` as little-endian float32 bytes, in array order. */
export function residentPositionsDigest(positions: Float32Array): string {
  return pointsSha256(positions);
}
