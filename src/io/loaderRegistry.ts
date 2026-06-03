/**
 * loaderRegistry.ts
 *
 * The single, declarative registry of point-cloud format decoders. It replaces
 * the former `pickLoader` switch: every decodable format maps to one loader
 * function.
 *
 * Each decoder is loaded **on demand** with a dynamic `import()`, so the heavy
 * libraries — laz-perf's embedded WASM, loaders.gl, the E57 reader — are split
 * into separate chunks and only the one format actually being opened is ever
 * fetched. Opening a `.ply` never pulls in the laz-perf WASM, and vice versa.
 * This module itself therefore imports no decoder and stays lightweight; the
 * format facts (labels, text/binary, header-count) live in `formatInfo.ts`.
 *
 * Adding a format is one entry here plus one in `formatInfo.ts`.
 */

import type { SourceFormat } from './sniffFormat';
import type { PointCloud } from '../model/PointCloud';
import type { ProgressUpdate } from './loadProgress';

/**
 * A function that turns a file buffer into a normalized `PointCloud`.
 *
 * `onProgress` is optional and used only by the chunked text loaders
 * (XYZ/CSV, PTS) to report decode progress; binary loaders ignore it.
 */
export type LoaderFn = (
  buffer: ArrayBuffer,
  name: string,
  onProgress?: (update: ProgressUpdate) => void,
) => Promise<PointCloud>;

/**
 * The decoder for each registered format. Every entry dynamically imports its
 * decoder module on first call, so each format's heavy dependencies land in a
 * separate, lazily-fetched chunk.
 */
const LOADERS: Record<SourceFormat, LoaderFn> = {
  las: async (buffer, name) => (await import('./loadLas')).loadLas(buffer, 'las', name),
  laz: async (buffer, name) => (await import('./loadLas')).loadLas(buffer, 'laz', name),
  e57: async (buffer, name) => (await import('./loadE57')).loadE57(buffer, name),
  ply: async (buffer, name) => (await import('./loadPly')).loadPly(buffer, name),
  obj: async (buffer, name) => (await import('./loadObj')).loadObj(buffer, name),
  glb: async (buffer, name) => (await import('./loadGltf')).loadGltf(buffer, 'glb', name),
  gltf: async (buffer, name) => (await import('./loadGltf')).loadGltf(buffer, 'gltf', name),
  xyz: async (buffer, name, onProgress) =>
    (await import('./loadXyz')).loadXyz(buffer, name, onProgress),
  pcd: async (buffer, name) => (await import('./loadPcd')).loadPcd(buffer, name),
  ptx: async (buffer, name) => (await import('./loadPtx')).loadPtx(buffer, name),
  pts: async (buffer, name, onProgress) =>
    (await import('./loadPts')).loadPts(buffer, name, onProgress),
};

/** The decoder for a format. Throws on an unregistered format. */
export function loaderFor(format: SourceFormat): LoaderFn {
  const fn = LOADERS[format];
  if (!fn) throw new Error(`No loader registered for format: ${String(format)}`);
  return fn;
}
