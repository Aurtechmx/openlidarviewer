/**
 * LAS / LAZ loader with full coordinate precision.
 *
 * ## Why this loader decodes point records by hand
 *
 * `@loaders.gl/las` returns vertex positions as **float32 global** UTM
 * coordinates. A float32 has only ~24 bits of mantissa, so a value such as
 * 4_100_876.789 snaps to roughly a 0.5 m grid — sub-metre detail is gone
 * before we can recenter it. On top of that, the bundled laz-perf build in
 * `@loaders.gl/las` rejects LAS 1.4 outright ("Only file versions <= 1.3 are
 * supported"), and its laz-rs loader fetches a WASM bundle from the network.
 *
 * To get reliable, offline, full-precision results this loader instead reads
 * the raw integer point records and converts them itself:
 *
 *  - **`.las`** (uncompressed): the point records are read straight from the
 *    file. Every LAS point record — for every point format — begins with
 *    int32 X, Y, Z. The point-data offset and record length come from the
 *    parsed public header. This path stays entirely inside this module.
 *  - **`.laz`** (compressed): the `laz-perf` WASM decoder is loaded LAZILY
 *    via `import('./lazDecode')` so that uncompressed `.las` files never pay
 *    the 290 KB WASM blob download cost. The decompressed record has the
 *    same int32 X/Y/Z prefix; the shared primitives in `lasDecodeShared.ts`
 *    do the actual record decode for both paths.
 *
 * ## Direct local-coordinate decode
 *
 * The render origin is computed from the header bounds *before* decoding, so
 * each record is converted straight into the local `Float32Array` the renderer
 * uses: `local = (int * scale + offset) - origin`. The whole right-hand side
 * is evaluated in float64 (JavaScript numbers are doubles) and only the final
 * store into the Float32Array narrows the small local residual.
 */

import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import { parseLasHeader } from './lasHeader';
import type { LasHeader } from './lasHeader';
import { computeOrigin } from './coordinateBridge';
import { makePrng, pickInBucket, STRIDE_SAMPLE_SEED } from './strideSample';
import type { ProgressUpdate } from './loadProgress';
import {
  allocRawPoints,
  classificationMaskFor,
  decodeContext,
  decodeRecord,
  decodingUpdate,
  finalizeRawColors,
  type RawPoints,
} from './lasDecodeShared';

// Re-export so external callers (analysis modules) keep their existing import path.
export { classificationMaskFor };

/**
 * Decode an uncompressed `.las` file. With `stride > 1` the records are split
 * into buckets of `stride` and one record is read from each at a jittered
 * offset (see `strideSample.ts`) — `.las` records are fixed-length and
 * randomly addressable, so the rest are skipped entirely (a genuine
 * decode-time saving for clouds far over budget). The jitter is what keeps
 * the fast-load result from banding along the scan lines.
 */
function decodeLas(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  stride: number,
  onProgress?: (u: ProgressUpdate) => void,
): RawPoints {
  const view = new DataView(buffer);
  const pointsOffset = header.offsetToPointData;
  const recordLength = header.pointDataRecordLength;
  const ctx = decodeContext(header, origin);

  // Clamp the count to what the file can actually hold. A header that claims
  // more points than the file contains would otherwise read past the buffer
  // and throw an opaque RangeError partway through the decode.
  const available =
    recordLength > 0 ? Math.floor((buffer.byteLength - pointsOffset) / recordLength) : 0;
  const count = Math.min(header.pointCount, Math.max(0, available));

  const step = Math.max(1, Math.floor(stride));
  const total = Math.ceil(count / step);
  const out = allocRawPoints(total, ctx.gpsTimeOffset !== null, ctx.rgbOffset !== null);
  const reportEvery = Math.max(1, Math.floor(total / 20));
  const rand = step > 1 ? makePrng(STRIDE_SAMPLE_SEED) : undefined;
  for (let b = 0; b < total; b++) {
    const i = rand ? pickInBucket(b, step, count, rand) : b;
    decodeRecord(view, pointsOffset + i * recordLength, b, ctx, out);
    if (onProgress && (b + 1) % reportEvery === 0) onProgress(decodingUpdate(b + 1, total));
  }
  finalizeRawColors(out); // narrow staged 16-bit RGB once, per-file
  return out;
}

/**
 * Re-export `getLazPerf` for the EPT laszip tile decoder. The dynamic
 * import here means the EPT path also pulls the lazy WASM chunk — exactly
 * the same chunk the `.laz` open path uses, so the single-instantiation
 * memo inside `lazDecode.ts` is shared across both call sites.
 *
 * Existing call shape preserved: `import { getLazPerf } from '../loadLas'`.
 */
export async function getLazPerf(): Promise<
  Awaited<ReturnType<typeof import('./lazDecode').getLazPerf>>
> {
  const mod = await import('./lazDecode');
  return mod.getLazPerf();
}

/**
 * Format a LAS header creation date. The header stores a day-of-year and a
 * year; a plausible year is required, and a valid day refines it to a date.
 */
function formatCreationDate(year: number, day: number): string | undefined {
  if (year < 1990 || year > 2100) return undefined;
  if (day < 1 || day > 366) return String(year);
  const date = new Date(Date.UTC(year, 0, day));
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Build provenance metadata from a LAS header — the capture sensor, the
 * software that wrote the file, and the creation date — keeping only the
 * fields the header actually filled in.
 */
function lasMetadata(header: LasHeader): CloudMetadata | undefined {
  const metadata: CloudMetadata = {};
  if (header.systemIdentifier) metadata.captureSensor = header.systemIdentifier;
  if (header.generatingSoftware) metadata.sourceSoftware = header.generatingSoftware;
  const captureDate = formatCreationDate(header.creationYear, header.creationDay);
  if (captureDate) metadata.captureDate = captureDate;
  // surface the CRS parsed from LASF_Projection VLRs so the
  // Scan Intelligence panel + scan-report card + measurement tool can show
  // the source datum and convert measurements from feet to metres when the
  // CRS declares a non-metric linear unit.
  if (header.crs) metadata.crs = header.crs;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Load a `.las` or `.laz` point cloud into a `PointCloud`.
 *
 * Positions are decoded directly into local space about a floored-min
 * `origin`; `intensity` and `classification` are decoded straight from the
 * (raw) point records. The header is parsed once and threaded into the
 * decoder.
 *
 * @param buffer       Raw file bytes.
 * @param sourceFormat Either `'las'` or `'laz'`.
 * @param name         Display name (defaults to `"cloud.<format>"`).
 * @param stride       Decode every `stride`-th record (1 = every record).
 *                     Used by the fast-load path for huge clouds.
 * @param onProgress   Optional staged-progress callback for the decode loop.
 */
export async function loadLas(
  buffer: ArrayBuffer,
  sourceFormat: 'las' | 'laz',
  name = `cloud.${sourceFormat}`,
  stride = 1,
  onProgress?: (u: ProgressUpdate) => void,
): Promise<PointCloud> {
  const header = parseLasHeader(buffer);
  // Origin from the floored header min — known before decoding, so records
  // are converted straight into local coordinates.
  const origin = computeOrigin(header.min);

  let raw: RawPoints;
  if (sourceFormat === 'laz') {
    // Lazy chunk: pulls laz-perf + the embedded WASM only when a `.laz`
    // file is actually opened. Uncompressed `.las` files never download it.
    const { decodeLaz } = await import('./lazDecode');
    raw = await decodeLaz(buffer, header, origin, stride, onProgress);
  } else {
    raw = decodeLas(buffer, header, origin, stride, onProgress);
  }

  const decodedPointCount = raw.positions.length / 3;

  return new PointCloud({
    positions: raw.positions,
    colors: raw.colors ?? undefined,
    intensity: raw.intensity,
    classification: raw.classification,
    returnNumber: raw.returnNumber,
    returnCount: raw.returnCount,
    pointSourceId: raw.pointSourceId,
    gpsTime: raw.gpsTime ?? undefined,
    origin,
    sourceFormat,
    name,
    declaredPointCount: header.pointCount,
    decodedPointCount,
    metadata: lasMetadata(header),
  });
}
