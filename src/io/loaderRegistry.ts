/**
 * loaderRegistry.ts
 *
 * The single, declarative registry of point-cloud format decoders. It replaces
 * the former `pickLoader` switch: every decodable format maps to one loader
 * function.
 *
 * This module imports every decoder (laz-perf, PCDLoader, loaders.gl, …), so it
 * is heavy — it belongs on the worker decode path. The lightweight format facts
 * (labels, text/binary, header-count) live in `formatInfo.ts`, which imports no
 * decoder, so the preflight and the main-thread UI can stay lean.
 *
 * Adding a format is one entry here plus one in `formatInfo.ts`.
 */

import type { SourceFormat } from './sniffFormat';
import type { PointCloud } from '../model/PointCloud';
import type { ProgressUpdate } from './loadProgress';
import { loadPly } from './loadPly';
import { loadLas } from './loadLas';
import { loadObj } from './loadObj';
import { loadGltf } from './loadGltf';
import { loadXyz } from './loadXyz';
import { loadE57 } from './loadE57';
import { loadPcd } from './loadPcd';
import { loadPtx } from './loadPtx';
import { loadPts } from './loadPts';

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

/** The decoder for each registered format. */
const LOADERS: Record<SourceFormat, LoaderFn> = {
  las: (buffer, name) => loadLas(buffer, 'las', name),
  laz: (buffer, name) => loadLas(buffer, 'laz', name),
  e57: (buffer, name) => loadE57(buffer, name),
  ply: (buffer, name) => loadPly(buffer, name),
  obj: (buffer, name) => loadObj(buffer, name),
  glb: (buffer, name) => loadGltf(buffer, 'glb', name),
  gltf: (buffer, name) => loadGltf(buffer, 'gltf', name),
  xyz: (buffer, name, onProgress) => loadXyz(buffer, name, onProgress),
  pcd: (buffer, name) => loadPcd(buffer, name),
  ptx: (buffer, name) => loadPtx(buffer, name),
  pts: (buffer, name, onProgress) => loadPts(buffer, name, onProgress),
};

/** The decoder for a format. Throws on an unregistered format. */
export function loaderFor(format: SourceFormat): LoaderFn {
  const fn = LOADERS[format];
  if (!fn) throw new Error(`No loader registered for format: ${String(format)}`);
  return fn;
}
