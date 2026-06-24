/**
 * lazDecode.ts
 *
 * Lazy-loaded LAZ decompression path. Hosts the heavyweight imports the LAS
 * loader doesn't need on uncompressed `.las` files:
 *
 *   - `laz-perf` (~100 KB JS glue + WASM bindings)
 *   - the embedded laz-perf WebAssembly bundle (~286 KB base64 blob)
 *
 * Splitting these out of `loadLas.ts` lets Vite emit a separate
 * `lazDecode-*.js` chunk that is only fetched when:
 *
 *   - the user opens a `.laz` file (`loadLas.ts` calls `await import('./lazDecode')`)
 *   - the EPT laszip tile decoder needs the WASM (also via dynamic import)
 *
 * Uncompressed `.las` files never pay the WASM download cost. This was the
 * single biggest contributor to the `loadLas` bundle warning — the WASM
 * blob alone is 286 KB of static content statically imported by every load
 * path.
 *
 * Contract:
 *
 *  - `getLazPerf()` is memoised. The first call instantiates the WASM (~30–50 ms);
 *    every later call returns the same module. The EPT laszip tile decoder
 *    relies on this single-instantiation guarantee for its hot path.
 *  - `decodeLaz()` honours the same `RawPoints` output shape and `stride` /
 *    `onProgress` contract as the inline implementation it replaces.
 */

import { createLazPerf } from 'laz-perf';
import { LAZ_PERF_WASM_BASE64 } from './lazPerfWasm';
import type { LasHeader } from './lasHeader';
import type { ProgressUpdate } from './loadProgress';
import { makePrng, pickInBucket, STRIDE_SAMPLE_SEED } from './strideSample';
import { validateDeclaredPointCount } from './validateCount';
import {
  allocRawPoints,
  decodeContext,
  decodeRecord,
  decodingUpdate,
  finalizeRawColors,
  type RawPoints,
} from './lasDecodeShared';

/**
 * Conservative floor on compressed bytes per LAZ point. Real-world LAZ
 * compresses ~30-byte records to roughly 2–5 bytes; 1 byte/point is far
 * below anything a genuine file produces, so the bound only trips on a
 * header lying about its count by orders of magnitude (the case that
 * matters — a remote file declaring 10^12 points would otherwise drive
 * a multi-terabyte allocation in `allocRawPoints` below).
 */
const MIN_COMPRESSED_BYTES_PER_POINT = 1;

/** Decode the embedded base64 laz-perf WASM into bytes for `createLazPerf`. */
function lazPerfWasmBinary(): Uint8Array {
  const binary = atob(LAZ_PERF_WASM_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The instantiated laz-perf WASM module. */
type LazPerfModule = Awaited<ReturnType<typeof createLazPerf>>;

/**
 * Memoised laz-perf WASM module. Instantiating the decoder is the fixed cost
 * of a LAZ load; once this module instance has done it, every later `.laz`
 * file reuses the same module — only the per-file `LASZip` reader is created
 * and freed each time. If instantiation fails the memo is cleared so the next
 * load can retry.
 */
let lazPerfModule: Promise<LazPerfModule> | undefined;

/**
 * exported so the EPT laszip tile decoder can reuse the same
 * cached WASM module. The single-instantiation contract (one WASM compile +
 * initialise per session, ~30-50 ms) is the load-bearing performance
 * guarantee — every EPT tile decode hits the cached path.
 */
export function getLazPerf(): Promise<LazPerfModule> {
  const existing = lazPerfModule;
  if (existing) return existing;
  const mod = createLazPerf({ wasmBinary: lazPerfWasmBinary() }).catch((err: unknown) => {
    lazPerfModule = undefined;
    throw err;
  });
  lazPerfModule = mod;
  return mod;
}

/**
 * Decode a compressed `.laz` file via the laz-perf WASM.
 *
 * Stride note: laz-perf decodes records strictly sequentially, so a
 * `stride > 1` cannot skip the decompression work — every record is still
 * decompressed. What stride saves on a `.laz` file is the coordinate transform
 * and the output storage: only one decompressed record per bucket is kept,
 * picked at a jittered offset so the result does not band along the scan lines.
 */
export async function decodeLaz(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  stride: number,
  onProgress?: (u: ProgressUpdate) => void,
): Promise<RawPoints> {
  const ctx = decodeContext(header, origin);
  // Bound the declared count by the compressed payload BEFORE sizing the
  // output arrays or entering the getPoint loop — the LAZ mirror of the
  // record-length clamp `loadLas.ts` applies to uncompressed files.
  const pointCount = validateDeclaredPointCount(
    header.pointCount,
    buffer.byteLength,
    MIN_COMPRESSED_BYTES_PER_POINT,
    'LAZ file',
  );
  const step = Math.max(1, Math.floor(stride));
  const total = Math.ceil(pointCount / step);

  const lazPerf = await getLazPerf();
  const fileBytes = new Uint8Array(buffer);

  const filePtr = lazPerf._malloc(fileBytes.byteLength);
  const reader = new lazPerf.LASZip();
  let pointPtr = 0;
  try {
    lazPerf.HEAPU8.set(fileBytes, filePtr);
    reader.open(filePtr, fileBytes.byteLength);

    const recordLength = reader.getPointLength();
    pointPtr = lazPerf._malloc(recordLength);

    const out = allocRawPoints(total, ctx.gpsTimeOffset !== null, ctx.rgbOffset !== null);
    const reportEvery = Math.max(1, Math.floor(pointCount / 20));

    const rand = step > 1 ? makePrng(STRIDE_SAMPLE_SEED) : undefined;
    let bucket = 0;
    let chosen = rand ? pickInBucket(0, step, pointCount, rand) : 0;

    let heap = new DataView(lazPerf.HEAPU8.buffer);
    for (let i = 0; i < pointCount; i++) {
      reader.getPoint(pointPtr);
      if (heap.buffer !== lazPerf.HEAPU8.buffer) {
        heap = new DataView(lazPerf.HEAPU8.buffer);
      }
      if (i === chosen && bucket < total) {
        decodeRecord(heap, pointPtr, bucket, ctx, out);
        bucket++;
        if (bucket < total) {
          chosen = rand ? pickInBucket(bucket, step, pointCount, rand) : bucket;
        }
      }
      if (onProgress && i % reportEvery === 0) onProgress(decodingUpdate(bucket, total));
    }
    finalizeRawColors(out); // narrow staged 16-bit RGB once, per-file
    return out;
  } finally {
    reader.delete();
    if (pointPtr) lazPerf._free(pointPtr);
    lazPerf._free(filePtr);
  }
}
