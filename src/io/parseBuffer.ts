import type { DetectedFormat } from './sniffFormat';
import { PointCloud } from '../model/PointCloud';
import { loadPly } from './loadPly';
import { loadLas } from './loadLas';
import { loadObj } from './loadObj';
import { loadGltf } from './loadGltf';
import { voxelDownsample, voxelSizeForBudget } from '../process/voxelDownsample';

/** Maximum points kept before a cloud is voxel-downsampled on load. */
export const POINT_BUDGET = 4_000_000;

/** A function that turns a file buffer into a normalized PointCloud. */
export type LoaderFn = (buffer: ArrayBuffer, name: string) => Promise<PointCloud>;

/** Outcome of parsing a file: the cloud plus how downsampling affected it. */
export interface LoadResult {
  cloud: PointCloud;
  /** Point count before any downsampling — the "total" the Detail slider shows. */
  originalPointCount: number;
  /** True if the cloud was voxel-downsampled to fit the point budget. */
  downsampled: boolean;
}

/**
 * Return the loader for a detected format. Throws on `unknown` so callers get
 * a clear error rather than a silent no-op.
 */
export function pickLoader(format: DetectedFormat): LoaderFn {
  switch (format) {
    case 'ply':
      return (buffer, name) => loadPly(buffer, name);
    case 'las':
      return (buffer, name) => loadLas(buffer, 'las', name);
    case 'laz':
      return (buffer, name) => loadLas(buffer, 'laz', name);
    case 'obj':
      return (buffer, name) => loadObj(buffer, name);
    case 'glb':
      return (buffer, name) => loadGltf(buffer, 'glb', name);
    case 'gltf':
      return (buffer, name) => loadGltf(buffer, 'gltf', name);
    case 'unknown':
      throw new Error('Unsupported or unrecognised file format');
    default: {
      const exhaustive: never = format;
      throw new Error(`Unhandled format: ${String(exhaustive)}`);
    }
  }
}

/**
 * Parse a file buffer into a PointCloud, downsampling if it exceeds the point
 * budget. DOM-free — safe to run on the main thread or inside a Web Worker.
 */
export async function parseBuffer(
  buffer: ArrayBuffer,
  format: DetectedFormat,
  name: string,
  budget = POINT_BUDGET,
): Promise<LoadResult> {
  const loader = pickLoader(format);
  const cloud = await loader(buffer, name);
  const originalPointCount = cloud.pointCount;

  if (originalPointCount <= budget) {
    return { cloud, originalPointCount, downsampled: false };
  }

  // Over budget: downsample, growing the voxel size until the cloud fits.
  let voxelSize = voxelSizeForBudget(cloud, budget);
  let reduced = voxelDownsample(cloud, voxelSize);
  for (let attempt = 0; attempt < 8 && reduced.pointCount > budget; attempt++) {
    voxelSize *= 1.5;
    reduced = voxelDownsample(cloud, voxelSize);
  }
  return { cloud: reduced, originalPointCount, downsampled: true };
}
