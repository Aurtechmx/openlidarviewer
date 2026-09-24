/**
 * terrainAccessDigest.ts — SHA-256 over the actual result, not its summary.
 *
 * Same motivation as `flowPulse/flowFieldDigest.ts`: a run record's digest
 * covers `result`, and two materially different eligibility grids or routes
 * can share every summary aggregate (equal cell count, equal cost, even equal
 * min/max diagnostics on a symmetric terrain) while disagreeing about which
 * cells were actually used. This hashes the eligibility mask and the path
 * itself, so two runs that differ anywhere seal to different digests.
 *
 * ── BYTE ENCODING (v1), row-major over `cols * rows` cells ──────────────────
 *   1. header:    UTF-8 "olv.simulation.terrain-access.result-digest.v1\n"
 *   2. cols:      Uint32, little-endian, 4 bytes
 *   3. rows:      Uint32, little-endian, 4 bytes
 *   4. blocked:   Uint8, 1 byte/cell — the post-width-clearance eligibility mask
 *   5. pathLength: Uint32, little-endian, 4 bytes
 *   6. path:      Int32, little-endian, 4 bytes per path cell (empty when no route)
 *   7. cost:      Float64, little-endian, 8 bytes — the route's total cost, or
 *      NaN's own bit pattern when there is no route
 *
 * Pure: no DOM, no three.js, no I/O, no clock.
 */

import { IncrementalSha256 } from '../../io/heavy/incrementalSha256';

/** Domain-separation header: names the encoding and pins it to a version. */
export const TERRAIN_ACCESS_DIGEST_ENCODING = 'olv.simulation.terrain-access.result-digest.v1';

/** SHA-256 over the eligibility mask and the found route (or its absence). */
export function terrainAccessResultDigest(
  cols: number,
  rows: number,
  blocked: Uint8Array,
  path: readonly number[],
  cost: number | null,
): string {
  const n = cols * rows;
  if (blocked.length !== n) {
    throw new RangeError(`terrainAccessResultDigest: blocked must be cols×rows (${n}); got ${blocked.length}`);
  }

  const hasher = new IncrementalSha256();
  hasher.update(new TextEncoder().encode(`${TERRAIN_ACCESS_DIGEST_ENCODING}\n`));

  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, cols, true);
  headerView.setUint32(4, rows, true);
  hasher.update(header);

  hasher.update(blocked);

  const pathHeader = new Uint8Array(4);
  new DataView(pathHeader.buffer).setUint32(0, path.length, true);
  hasher.update(pathHeader);

  const pathBytes = new Uint8Array(path.length * 4);
  const pathView = new DataView(pathBytes.buffer);
  for (let i = 0; i < path.length; i++) pathView.setInt32(i * 4, path[i], true);
  hasher.update(pathBytes);

  const costBytes = new Uint8Array(8);
  new DataView(costBytes.buffer).setFloat64(0, cost ?? Number.NaN, true);
  hasher.update(costBytes);

  return hasher.digestHex();
}
