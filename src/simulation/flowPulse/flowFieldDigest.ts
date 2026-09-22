/**
 * flowFieldDigest.ts — SHA-256 over the routed field itself, not its summary.
 *
 * A run record's digest covers `result`, and until this module existed
 * `result` held only the summary: cell counts and a couple of maxima. Two
 * materially different receiver or accumulation arrays can share every one
 * of those figures — equal sink, flat and outlet counts, equal
 * maxUpstreamCells — because the summary is a handful of aggregates, not the
 * field. A digest built only from the summary agrees on two runs that never
 * routed the same way. This hashes the arrays a reader would actually
 * compare a run against, so two fields that differ anywhere seal to
 * different digests.
 *
 * ── BYTE ENCODING (v1), all row-major over `cols * rows` cells ─────────────
 *   1. header:      UTF-8 "olv.simulation.terrain-flow.field-digest.v1\n"
 *   2. cols:        Uint32, little-endian, 4 bytes
 *   3. rows:        Uint32, little-endian, 4 bytes
 *   4. conditioned: Uint8, 1 byte — 1 when the conditioned elevations are
 *      appended (field 9 below), 0 in raw mode
 *   5. receiver:    Int32, little-endian, 4 bytes/cell (D8Result.receiver)
 *   6. direction:   Uint8, 1 byte/cell, the bit pattern of
 *      D8Result.direction (one byte carries no endianness)
 *   7. status:      Uint8, 1 byte/cell (D8Result.status)
 *   8. upstream:    Uint32, little-endian, 4 bytes/cell
 *      (AccumulationResult.upstreamCells)
 *   9. conditioned z: Float32, little-endian, 4 bytes/cell — present only
 *      when conditioning ran (PriorityFloodResult.z)
 *
 * A caller comparing two runs is comparing bytes, not parsed JSON: hashing an
 * array by first rendering it through JSON.stringify would cost a string
 * allocation and a decimal conversion per number, on top of tying the digest
 * to whatever formatting JSON happens to choose for a float. Feeding the
 * typed arrays' own bytes through the streaming hasher below keeps the cost
 * to one pass over memory already held and never materialises more than one
 * array's encoding at a time.
 *
 * Changing this layout is a version bump, in the constant below and in the
 * header string, never a silent reinterpretation: a pinned fixture digest in
 * the test suite exists to catch a layout drift that every other test would
 * read as "the same".
 *
 * Pure: no DOM, no three.js, no I/O, no clock.
 */

import { IncrementalSha256 } from '../../io/heavy/incrementalSha256';
import type { D8Result } from './d8Flow';
import type { AccumulationResult } from './flowAccumulation';
import type { PriorityFloodResult } from './priorityFlood';

/** Domain-separation header: names the encoding and pins it to a version. */
export const FLOW_FIELD_DIGEST_ENCODING = 'olv.simulation.terrain-flow.field-digest.v1';

function byteViewOf(values: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

function feedInt32LE(hasher: IncrementalSha256, values: Int32Array): void {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setInt32(i * 4, values[i], true);
  hasher.update(bytes);
}

function feedUint32LE(hasher: IncrementalSha256, values: Uint32Array): void {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i], true);
  hasher.update(bytes);
}

function feedFloat32LE(hasher: IncrementalSha256, values: Float32Array): void {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
  hasher.update(bytes);
}

/**
 * SHA-256 over the routed field, not the summary derived from it. See the
 * module doc for the exact byte layout.
 *
 * `conditioned` is null in raw mode; when it is present its elevations are
 * appended so a raw run and a conditioned run over the same terrain, which
 * can otherwise share every summary figure, seal to different digests.
 */
export function flowFieldDigest(
  grid: { readonly cols: number; readonly rows: number },
  routed: D8Result,
  accumulation: AccumulationResult,
  conditioned: PriorityFloodResult | null,
): string {
  const n = grid.cols * grid.rows;
  if (routed.receiver.length !== n || routed.direction.length !== n || routed.status.length !== n) {
    throw new RangeError(
      `flowFieldDigest: routed arrays must be cols×rows (${n}); got receiver=${routed.receiver.length} `
      + `direction=${routed.direction.length} status=${routed.status.length}`,
    );
  }
  if (accumulation.upstreamCells.length !== n) {
    throw new RangeError(
      `flowFieldDigest: upstreamCells must be cols×rows (${n}); got ${accumulation.upstreamCells.length}`,
    );
  }
  if (conditioned && conditioned.z.length !== n) {
    throw new RangeError(`flowFieldDigest: conditioned.z must be cols×rows (${n}); got ${conditioned.z.length}`);
  }

  const hasher = new IncrementalSha256();
  hasher.update(new TextEncoder().encode(`${FLOW_FIELD_DIGEST_ENCODING}\n`));

  const header = new Uint8Array(9);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, grid.cols, true);
  headerView.setUint32(4, grid.rows, true);
  header[8] = conditioned ? 1 : 0;
  hasher.update(header);

  feedInt32LE(hasher, routed.receiver);
  hasher.update(byteViewOf(routed.direction));
  hasher.update(byteViewOf(routed.status));
  feedUint32LE(hasher, accumulation.upstreamCells);
  if (conditioned) feedFloat32LE(hasher, conditioned.z);

  return hasher.digestHex();
}
