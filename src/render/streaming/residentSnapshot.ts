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
}

/**
 * Concatenate the decoded resident chunks into one PointCloud, or return null
 * when nothing is resident yet. Optional channels (RGB, point-source id) are
 * emitted only when EVERY chunk carries them, so a partially-attributed set
 * never produces a half-filled array the writers would misread.
 */
export function buildResidentSnapshot(
  chunks: readonly DecodedChunk[],
  opts: ResidentSnapshotOptions,
): PointCloud | null {
  let total = 0;
  for (const c of chunks) total += c.pointCount;
  if (total === 0) return null;

  const positions = new Float32Array(total * 3);
  const intensity = new Uint16Array(total);
  const classification = new Uint8Array(total);
  const returnNumber = new Uint8Array(total);
  const returnCount = new Uint8Array(total);
  const gpsTime = new Float64Array(total);

  const allRgb = chunks.every((c) => c.rgb !== undefined && c.rgb.length >= c.pointCount * 3);
  const allPsid = chunks.every(
    (c) => c.pointSourceId !== undefined && c.pointSourceId.length >= c.pointCount,
  );
  const colors = allRgb ? new Uint8Array(total * 3) : undefined;
  const pointSourceId = allPsid ? new Uint16Array(total) : undefined;

  let p = 0; // running point offset
  for (const c of chunks) {
    const n = c.pointCount;
    positions.set(c.positions.subarray(0, n * 3), p * 3);
    intensity.set(c.intensity.subarray(0, n), p);
    classification.set(c.classification.subarray(0, n), p);
    returnNumber.set(c.returnNumber.subarray(0, n), p);
    returnCount.set(c.returnCount.subarray(0, n), p);
    gpsTime.set(c.gpsTime.subarray(0, n), p);
    if (colors && c.rgb) colors.set(c.rgb.subarray(0, n * 3), p * 3);
    if (pointSourceId && c.pointSourceId) pointSourceId.set(c.pointSourceId.subarray(0, n), p);
    p += n;
  }

  return new PointCloud({
    positions,
    intensity,
    classification,
    returnNumber,
    returnCount,
    gpsTime,
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
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });
}
