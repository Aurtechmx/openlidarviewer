/**
 * residentSnapshot.ts
 *
 * Assemble the decoded resident nodes of a streaming cloud into a single
 * in-memory {@link PointCloud} — the snapshot the Export / Convert panel writes
 * when a streaming (COPC / EPT) scan is open. Streaming point-cloud convert has
 * no full-resolution re-read (the source is remote / range-read), so the honest
 * export is exactly what is resident: the display-resolution points already
 * decoded and shown.
 *
 * Feasible with no GPU readback: `StreamingRenderer` keeps each resident node's
 * `DecodedChunk` CPU-side for recolouring, so this is a pure concatenation.
 * Positions stay in local (render-origin-shifted) space and `origin` records
 * the shift, exactly like a static cloud — `convertCloud` adds the origin back
 * to recover source coordinates.
 *
 * Pure — no DOM, no three.js, no GPU. Unit-testable in Node.
 */

import type { DecodedChunk } from '../../io/copc/copcChunkDecode';
import { PointCloud, type CloudMetadata } from '../../model/PointCloud';
import { renderLocalPositions } from '../../model/pointFrames';
import type { SourceFormat } from '../../io/sniffFormat';

/** Non-geometry inputs the snapshot needs from the streaming source. */
export interface ResidentSnapshotOptions {
  /** The render-origin the chunk positions were recentred against. */
  origin: readonly [number, number, number];
  /** Display name (the scan / file name). */
  name: string;
  /** Source format for provenance — COPC and EPT both decode LAZ records. */
  sourceFormat: SourceFormat;
  /** Provenance metadata (CRS, sensor, …) when the source carries it. */
  metadata?: CloudMetadata;
  /**
   * The SOURCE file's declared total, when the streaming metadata carries it.
   * Rides `PointCloud.sourceDeclaredPointCount` so the exporters can state
   * resident-of-source; `declaredPointCount` stays the resident total so the
   * Health Check keeps reading the snapshot as internally consistent.
   */
  sourcePointCount?: number;
}

/**
 * Concatenate the decoded resident chunks into one PointCloud, or return null
 * when nothing is resident yet.
 *
 * EVERY per-point channel is emitted only when EVERY chunk carries it, so a
 * partially-attributed set never produces a half-filled array the writers would
 * misread. That rule used to cover only RGB and point-source id; it now covers
 * intensity, classification, returns and GPS time too, because a chunk from a
 * format that carries none of them (a `.pnts` tile) would otherwise contribute
 * zeros an exported LAS would present as real classifications and readings.
 * `PointCloud` already treats each of these as optional, so the writers omit
 * the field rather than write a fabricated one.
 */
export function buildResidentSnapshot(
  chunks: readonly DecodedChunk[],
  opts: ResidentSnapshotOptions,
): PointCloud | null {
  let total = 0;
  for (const c of chunks) total += c.pointCount;
  if (total === 0) return null;

  const positions = new Float32Array(total * 3);

  /** Whether every chunk carries this channel at full length. */
  const everyChunkHas = (
    pick: (c: DecodedChunk) => ArrayLike<number> | undefined,
    perPoint: number,
  ): boolean => chunks.every((c) => (pick(c)?.length ?? -1) >= c.pointCount * perPoint);

  const intensity = everyChunkHas((c) => c.intensity, 1) ? new Uint16Array(total) : undefined;
  const classification = everyChunkHas((c) => c.classification, 1)
    ? new Uint8Array(total)
    : undefined;
  const returnNumber = everyChunkHas((c) => c.returnNumber, 1)
    ? new Uint8Array(total)
    : undefined;
  const returnCount = everyChunkHas((c) => c.returnCount, 1) ? new Uint8Array(total) : undefined;
  const gpsTime = everyChunkHas((c) => c.gpsTime, 1) ? new Float64Array(total) : undefined;
  const colors = everyChunkHas((c) => c.rgb, 3) ? new Uint8Array(total * 3) : undefined;
  const pointSourceId = everyChunkHas((c) => c.pointSourceId, 1)
    ? new Uint16Array(total)
    : undefined;

  let p = 0; // running point offset
  for (const c of chunks) {
    const n = c.pointCount;
    positions.set(renderLocalPositions(c).subarray(0, n * 3), p * 3);
    if (intensity && c.intensity) intensity.set(c.intensity.subarray(0, n), p);
    if (classification && c.classification) {
      classification.set(c.classification.subarray(0, n), p);
    }
    if (returnNumber && c.returnNumber) returnNumber.set(c.returnNumber.subarray(0, n), p);
    if (returnCount && c.returnCount) returnCount.set(c.returnCount.subarray(0, n), p);
    if (gpsTime && c.gpsTime) gpsTime.set(c.gpsTime.subarray(0, n), p);
    if (colors && c.rgb) colors.set(c.rgb.subarray(0, n * 3), p * 3);
    if (pointSourceId && c.pointSourceId) pointSourceId.set(c.pointSourceId.subarray(0, n), p);
    p += n;
  }

  return new PointCloud({
    positions,
    ...(intensity ? { intensity } : {}),
    ...(classification ? { classification } : {}),
    ...(returnNumber ? { returnNumber } : {}),
    ...(returnCount ? { returnCount } : {}),
    ...(gpsTime ? { gpsTime } : {}),
    ...(colors ? { colors } : {}),
    ...(pointSourceId ? { pointSourceId } : {}),
    origin: [opts.origin[0], opts.origin[1], opts.origin[2]],
    sourceFormat: opts.sourceFormat,
    name: opts.name,
    // A streaming snapshot is exactly what is resident — the decoded count IS
    // the declared count for this in-memory cloud, so the Health Check doesn't
    // read it as a lossy decode of a larger file.
    declaredPointCount: total,
    decodedPointCount: total,
    ...(opts.sourcePointCount !== undefined && opts.sourcePointCount > total
      ? { sourceDeclaredPointCount: opts.sourcePointCount }
      : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });
}
