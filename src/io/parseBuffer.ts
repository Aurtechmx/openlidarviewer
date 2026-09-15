import type { DetectedFormat } from './sniffFormat';
import { PointCloud } from '../model/PointCloud';
import { loaderFor } from './loaderRegistry';
import type { LoaderFn } from './loaderRegistry';
import { isRegisteredFormat } from './formatInfo';
import { downsampleToBudget } from '../process/voxelDownsample';
import { LoadError } from './loadErrors';
import type { LoadPlan, E57DecodePlan } from './loadPlan';
import type { ProgressUpdate } from './loadProgress';
import type { LoadTelemetry } from './loadTelemetry';
import type { LazLoadStats, PreviewChunkSink } from './loadLas';
import type { DecodePoolPolicy } from './heavy/worker/lazChunkWorkerClient';

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
 * Reject a cloud with no points. A zero-point file is well-formed on disk but
 * has nothing to display, and an empty cloud poisons everything downstream:
 * `bounds()` spans no points, the framing camera targets a degenerate box, and
 * the canvas renders black with no explanation. Fail here, once, at the single
 * funnel every static loader passes through, with a message the toast can show.
 */
function assertNonEmptyCloud(cloud: PointCloud): void {
  if (cloud.pointCount === 0) {
    throw new LoadError(
      'malformed-file',
      'This file is empty — it contains no points to display.',
    );
  }
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
 * `e57Plan` is the E57 equivalent, read from that format's XML declaration. It
 * is handed to `loadE57` so the decode applies the caller's plan; without it
 * the loader plans from the device signals of whatever thread it runs on, and
 * inside a worker those are always the desktop ones.
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
  e57Plan?: E57DecodePlan,
): Promise<LoadResult> {
  // --- Budget-aware fast load: LAS/LAZ with a preflight plan. ---
  if (plan && (format === 'las' || format === 'laz')) {
    onProgress?.({ stage: 'decoding' });
    const stride = plan.mode === 'stride' ? plan.stride : 1;
    // `loadLas` carries the laz-perf WASM — imported on demand so that heavy
    // decoder is its own chunk, fetched only when a LAS/LAZ file is opened.
    const { loadLas } = await import('./loadLas');
    const cloud = await loadLas(buffer, format, name, stride, onProgress);
    return budgetedLas(cloud, plan, onProgress);
  }

  onProgress?.({ stage: 'decoding' });
  // The registry's E57 entry calls `loadE57(buffer, name)`, which leaves the
  // loader to plan for itself. With a plan from the caller, route around it so
  // the plan reaches the decode.
  const loader: LoaderFn =
    e57Plan && format === 'e57'
      ? async (buf, nm) => (await import('./loadE57')).loadE57(buf, nm, { plan: e57Plan })
      : pickLoader(format);
  // The chunked text loaders (XYZ/CSV, PTS) report decode progress; binary
  // loaders ignore the callback.
  const cloud = await loader(buffer, name, onProgress);
  assertNonEmptyCloud(cloud);
  const originalPointCount = cloud.pointCount;

  // Voxel-downsample if the cloud exceeds the budget. `downsampleToBudget`
  // returns the same cloud object untouched when it already fits.
  onProgress?.({ stage: 'optimizing' });
  const reduced = downsampleToBudget(cloud, budget);
  return { cloud: reduced, originalPointCount, downsampled: reduced !== cloud };
}

/**
 * Parse from the `File` itself. A `.laz` with a plan is decoded by
 * `loadLazFromFile`, which reads the header and, when the pool engages, each
 * chunk on demand, so the worker never holds the compressed file whole. Every
 * other format is read whole here and handed to {@link parseBuffer}.
 */
export async function parseFile(
  file: File,
  format: DetectedFormat,
  name: string,
  budget = POINT_BUDGET,
  plan?: LoadPlan,
  onProgress?: (u: ProgressUpdate) => void,
  e57Plan?: E57DecodePlan,
  onPreviewChunk?: PreviewChunkSink,
  onStats?: (stats: LazLoadStats) => void,
  policy?: DecodePoolPolicy,
): Promise<LoadResult> {
  if (plan && format === 'laz') {
    onProgress?.({ stage: 'decoding' });
    const stride = plan.mode === 'stride' ? plan.stride : 1;
    const { loadLazFromFile } = await import('./loadLas');
    const cloud = await loadLazFromFile(file, name, stride, onProgress, onPreviewChunk, onStats, policy);
    return budgetedLas(cloud, plan, onProgress);
  }
  onProgress?.({ stage: 'reading-file' });
  const buffer = await file.arrayBuffer();
  return parseBuffer(buffer, format, name, budget, plan, onProgress, e57Plan);
}

/** The plan's budget step after a LAS/LAZ decode: voxel-reduce, or stride then reduce. */
function budgetedLas(
  cloud: PointCloud,
  plan: LoadPlan,
  onProgress?: (u: ProgressUpdate) => void,
): LoadResult {
  assertNonEmptyCloud(cloud);
  if (plan.mode === 'voxel') {
    // Decoded in full, then voxel-reduced to the plan's budget.
    const originalPointCount = cloud.pointCount;
    onProgress?.({ stage: 'optimizing' });
    const reduced = downsampleToBudget(cloud, plan.budget);
    return { cloud: reduced, originalPointCount, downsampled: reduced !== cloud };
  }
  if (plan.mode === 'stride') {
    // The strided cloud is a memory-safe intermediate; voxel-reducing it to
    // the budget equalises density, the same pass medium clouds get, so the
    // result has no scan-line aliasing and no flight-strip density blocks.
    // The "total" the Detail slider shows is the true source count.
    onProgress?.({ stage: 'optimizing' });
    const reduced = downsampleToBudget(cloud, plan.budget);
    return { cloud: reduced, originalPointCount: plan.sourceCount, downsampled: true };
  }
  return { cloud, originalPointCount: cloud.pointCount, downsampled: false };
}
