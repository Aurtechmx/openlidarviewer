import type { DetectedFormat } from './sniffFormat';
import { PointCloud } from '../model/PointCloud';
import { loaderFor } from './loaderRegistry';
import type { LoaderFn } from './loaderRegistry';
import { isRegisteredFormat } from './formatInfo';
import { downsampleToBudget } from '../process/voxelDownsample';
import type { LoadPlan } from './loadPlan';
import type { ProgressUpdate } from './loadProgress';
import type { LoadTelemetry } from './loadTelemetry';

export type { LoaderFn } from './loaderRegistry';

/** Maximum points kept before a cloud is voxel-downsampled on load. */
export const POINT_BUDGET = 4_000_000;

/**
 * A tighter point budget for phones. Mobile GPUs have far less memory and
 * fill-rate than a desktop, so a phone downsamples more aggressively to keep
 * a dropped survey interactive. The full-resolution file is never altered —
 * only what is uploaded to the GPU.
 */
export const MOBILE_POINT_BUDGET = 1_500_000;

/** Outcome of parsing a file: the cloud plus how downsampling affected it. */
export interface LoadResult {
  cloud: PointCloud;
  /** Point count before any downsampling — the "total" the Detail slider shows. */
  originalPointCount: number;
  /** True if the cloud was voxel-downsampled to fit the point budget. */
  downsampled: boolean;
  /** Per-stage timings, attached by `loadFile` and surfaced only in debug mode. */
  telemetry?: LoadTelemetry;
}

/**
 * Return the loader for a detected format. Throws on `unknown` (or any
 * unregistered format) so callers get a clear error rather than a silent
 * no-op. Thin compatibility wrapper over the {@link loaderFor} registry.
 */
export function pickLoader(format: DetectedFormat): LoaderFn {
  if (!isRegisteredFormat(format)) {
    throw new Error('Unsupported or unrecognised file format');
  }
  return loaderFor(format);
}

/**
 * Parse a file buffer into a PointCloud, downsampling if it exceeds the point
 * budget. DOM-free — safe to run on the main thread or inside a Web Worker.
 *
 * When a `plan` is supplied (LAS/LAZ only — the formats whose header reveals a
 * point count up front) the budget-aware fast-load path is taken: the cloud is
 * decoded in full, decoded-then-voxel-reduced, or stride-decoded, per the
 * plan's mode. Every other format keeps the decode-then-downsample path.
 *
 * `onProgress` receives staged-progress updates (`decoding`, `optimizing`).
 */
export async function parseBuffer(
  buffer: ArrayBuffer,
  format: DetectedFormat,
  name: string,
  budget = POINT_BUDGET,
  plan?: LoadPlan,
  onProgress?: (u: ProgressUpdate) => void,
): Promise<LoadResult> {
  // --- Budget-aware fast load: LAS/LAZ with a preflight plan. ---
  if (plan && (format === 'las' || format === 'laz')) {
    onProgress?.({ stage: 'decoding' });
    const stride = plan.mode === 'stride' ? plan.stride : 1;
    // `loadLas` carries the laz-perf WASM — imported on demand so that heavy
    // decoder is its own chunk, fetched only when a LAS/LAZ file is opened.
    const { loadLas } = await import('./loadLas');
    const cloud = await loadLas(buffer, format, name, stride, onProgress);

    if (plan.mode === 'voxel') {
      // Decoded in full, then voxel-reduced to the plan's budget.
      const originalPointCount = cloud.pointCount;
      onProgress?.({ stage: 'optimizing' });
      const reduced = downsampleToBudget(cloud, plan.budget);
      return { cloud: reduced, originalPointCount, downsampled: reduced !== cloud };
    }
    if (plan.mode === 'stride') {
      // The strided cloud is a memory-safe intermediate; voxel-reducing it to
      // the budget equalises density — the same pass medium clouds get — so
      // the result has no scan-line aliasing and no flight-strip density
      // blocks. The "total" the Detail slider shows is the true source count.
      onProgress?.({ stage: 'optimizing' });
      const reduced = downsampleToBudget(cloud, plan.budget);
      return { cloud: reduced, originalPointCount: plan.sourceCount, downsampled: true };
    }
    // 'all' — the whole cloud was decoded; nothing was reduced.
    return { cloud, originalPointCount: cloud.pointCount, downsampled: false };
  }

  // --- Every other format: decode fully, then voxel-downsample to budget. ---
  onProgress?.({ stage: 'decoding' });
  const loader = pickLoader(format);
  // The chunked text loaders (XYZ/CSV, PTS) report decode progress; binary
  // loaders ignore the callback.
  const cloud = await loader(buffer, name, onProgress);
  const originalPointCount = cloud.pointCount;

  // Voxel-downsample if the cloud exceeds the budget. `downsampleToBudget`
  // returns the same cloud object untouched when it already fits.
  onProgress?.({ stage: 'optimizing' });
  const reduced = downsampleToBudget(cloud, budget);
  return { cloud: reduced, originalPointCount, downsampled: reduced !== cloud };
}
