/**
 * gzip.ts
 *
 * An honest stop-gap for compressed point-cloud export. True LAZ encoding has no
 * maintained in-browser encoder (the bundled laz-perf is a DECODER only), so
 * rather than ship LAZ that doesn't work or vendor an unaudited WASM blob, we
 * offer gzip-compressed LAS — `.las.gz`. It uses the platform's built-in
 * `CompressionStream`, adds no dependency, shrinks a LAS file ~2–4×, and is read
 * by PDAL, `las2las` (after gunzip), and every `gzip`/`gunzip` tool.
 *
 * This is a CONTAINER compression, not LAZ's point-format compression — we label
 * it as exactly that in the UI so no one mistakes a `.las.gz` for a `.laz`.
 *
 * Async by nature (streaming), so it lives at the I/O boundary: `convertCloud`
 * stays synchronous and pure, and the download path awaits this last step.
 */

import type { ConvertedFile } from './types';

/**
 * Gzip a byte buffer using `CompressionStream` (browsers + Node ≥ 18). Throws if
 * the platform lacks it, so the caller can fall back to an uncompressed write
 * rather than silently producing a corrupt file.
 */
export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (typeof CS !== 'function') {
    throw new Error('Gzip compression is not available in this browser.');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CS('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** True when gzip export can run here. Drives the UI's availability gate. */
export function gzipAvailable(): boolean {
  return typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === 'function';
}

/**
 * Wrap a produced file as its gzip-compressed sibling: `name.las` → `name.las.gz`,
 * `application/gzip` MIME, gzipped bytes. Returns the file untouched when
 * `compress` is false. Only meaningful for binary LAS output.
 */
export async function gzipConvertedFile(
  file: ConvertedFile,
  compress: boolean,
): Promise<ConvertedFile> {
  if (!compress) return file;
  const bytes = await gzipBytes(file.bytes);
  return { filename: `${file.filename}.gz`, mime: 'application/gzip', bytes };
}
