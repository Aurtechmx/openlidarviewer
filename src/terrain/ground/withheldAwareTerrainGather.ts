/**
 * withheldAwareTerrainGather.ts: recovers the Withheld outcome for a static
 * source the display path voxel-downsampled at load.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 * `sampleStridedTerrain` (`src/render/terrainStreamSample.ts`) is the one
 * canonical terrain gather: it drops Withheld points from a buffer that
 * carries a flags channel and stamps the DTM with what it did. A static file
 * under the 4M-point display budget keeps its flags, so the gather can say
 * "excluded". A larger file is voxel-downsampled at load (`downsampleToBudget`
 * in `src/io/parseBuffer.ts`), and the reduction leaves `classificationFlags`
 * undefined on the reduced cloud (L28: a voxel's members can disagree about
 * Withheld, so the reduction states none rather than guessing one). The
 * canonical gather then reads a buffer with no flags channel, so it can only
 * say "not recorded". That is not because the source has no Withheld points;
 * it is because the buffer it was handed can no longer say either way.
 *
 * The route that does not touch the displayed cloud is a SECOND gather over
 * the FULL-RESOLUTION source, run only to answer the Withheld question and to
 * build the DTM the terrain-derived products (Flow Pulse among them) actually
 * read. `gatherWithheldAwareTerrainSource` re-decodes the original bytes
 * through {@link decodeFull}, the same source-faithful re-decode the Export
 * panel's full-resolution export already uses to keep flags a reduced view
 * loses, and hands the full-resolution buffer to `sampleStridedTerrain`
 * unchanged. The Withheld exclusion, the stride-invariance guarantee, and the
 * "excluded / not recorded / kept" declaration are exactly the ones the
 * canonical gather already makes. Nothing here reimplements Withheld
 * filtering (§16): this module supplies that gather a buffer with its flags
 * intact, which is the one thing the display path could not.
 *
 * ── WHAT THIS NEVER TOUCHES ──────────────────────────────────────────────────
 * The re-decode reads the same source bytes a second time into a buffer of
 * its own; it never reads or writes `PointCloud.positions`,
 * `classificationFlags`, `CloudMetadata`, or any state the display path
 * produced. A caller that never invokes this function changes nothing, and a
 * caller that does gets back a fresh sample and, optionally, a fresh
 * `TerrainCore`. It never mutates anything already loaded.
 *
 * ── BUDGETS, AND WHICH ONES ARE NEW ──────────────────────────────────────────
 * Re-decoding a whole file materialises it as one buffer plus expanded typed
 * attribute arrays, the same cost the Export panel's full-resolution export
 * already assesses. `WITHHELD_GATHER_MAX_SOURCE_BYTES` reuses that assessor's
 * ceiling (`FULL_EXPORT_CONFIRM_BYTES`, 750 MiB) rather than inventing a
 * second number for the same risk, but applies it as a hard refusal instead
 * of a confirm prompt, since this gather runs in the background with no user
 * to ask. `WITHHELD_GATHER_TIMEOUT_MS` is new: no existing ceiling bounds how
 * long a re-decode may run, so a generous, documented wall-clock budget is
 * introduced here and only here. The DTM allocation itself is bounded for
 * free: {@link gatherWithheldAwareTerrainCore} rasterises through
 * `computeTerrainCore` and `rasterizeDtm`, which already calls
 * `checkGridBudget` before allocating a grid.
 *
 * A source that cannot be re-read within these limits (too large, too slow,
 * cancelled, or simply unparseable) resolves to `null`. The caller's DTM
 * keeps whatever Withheld outcome it already had ("not recorded" stays "not
 * recorded"), which is the honest answer when the recovery itself could not
 * be attempted safely.
 *
 * Pure orchestration: no DOM, no cloud/Viewer state, no mutation of its input.
 */

import { decodeFull } from '../../convert/decodeFull';
import { FULL_EXPORT_CONFIRM_BYTES } from '../../convert/exportMemoryGuard';
import {
  sampleStridedTerrain,
  type StridedTerrainSample,
  type TerrainStreamBuffer,
} from '../../render/terrainStreamSample';
import { computeTerrainCore, type TerrainCore, type TerrainCoreParams } from '../contour/analyseContours';
import type { PointCloud } from '../../model/PointCloud';

/**
 * Byte ceiling above which a source is not re-decoded at all. Reuses
 * `FULL_EXPORT_CONFIRM_BYTES`, the export path's own "a full re-decode could
 * exhaust the tab" threshold, as a hard refusal rather than a prompt.
 */
export const WITHHELD_GATHER_MAX_SOURCE_BYTES = FULL_EXPORT_CONFIRM_BYTES;

/**
 * Wall-clock budget for the re-decode, in milliseconds. NEW to this seam (see
 * the module doc): no other ceiling in the terrain core bounds decode time.
 * 30s comfortably covers a worker-backed decode of a file at the byte ceiling
 * above on ordinary hardware while still failing closed on a genuinely stuck
 * decode rather than hanging the caller indefinitely.
 */
export const WITHHELD_GATHER_TIMEOUT_MS = 30_000;

/** The terrain gather's own display-budget default (`Viewer.gatherTerrainPositions`). */
const DEFAULT_MAX_POINTS = 300_000;

/** Re-decode function shape, for dependency injection in tests. */
export type DecodeFullFn = (
  buffer: ArrayBuffer,
  name: string,
  signal?: AbortSignal,
) => Promise<PointCloud>;

export interface WithheldAwareGatherOptions {
  /**
   * Points the recovered gather is strided down to, matching the canonical
   * gather's own default so a recovered DTM is built from the same-sized
   * sample the display path would have produced had its flags survived.
   */
  readonly maxPoints?: number;
  /** Override for {@link WITHHELD_GATHER_MAX_SOURCE_BYTES} (tests). */
  readonly maxSourceBytes?: number;
  /** Override for {@link WITHHELD_GATHER_TIMEOUT_MS} (tests). */
  readonly timeoutMs?: number;
  /** Cancels the re-decode; an already-aborted signal refuses immediately. */
  readonly signal?: AbortSignal;
  /** Injected re-decode function (tests); defaults to the real {@link decodeFull}. */
  readonly decodeFn?: DecodeFullFn;
}

export interface WithheldAwareGatherResult {
  /** The canonical gather's sample, built over the full-resolution source. */
  readonly sample: StridedTerrainSample;
  /** Points the full-resolution decode actually held, before striding. */
  readonly totalPoints: number;
}

/**
 * Re-decode `buffer` at full resolution and run it through the SAME canonical
 * gather (`sampleStridedTerrain`) the display path uses, so a source whose
 * flags did not survive voxel-downsampling at load gets a second chance to
 * declare its Withheld outcome honestly.
 *
 * Returns `null` (never throws for an ordinary refusal) when the source is
 * over the byte ceiling, the re-decode is aborted or exceeds its time budget,
 * the format cannot be decoded, or the decode yields no finite point. Each of
 * these is "the recovery could not be attempted safely", which is exactly the
 * case the caller's existing "not recorded" outcome already covers honestly.
 */
export async function gatherWithheldAwareTerrainSource(
  buffer: ArrayBuffer,
  name: string,
  options: WithheldAwareGatherOptions = {},
): Promise<WithheldAwareGatherResult | null> {
  if (options.signal?.aborted) return null;

  const maxSourceBytes = options.maxSourceBytes ?? WITHHELD_GATHER_MAX_SOURCE_BYTES;
  if (!Number.isFinite(buffer.byteLength) || buffer.byteLength <= 0) return null;
  if (buffer.byteLength > maxSourceBytes) return null;

  const timeoutMs = options.timeoutMs ?? WITHHELD_GATHER_TIMEOUT_MS;
  const decodeFn = options.decodeFn ?? decodeFull;
  const internalAbort = new AbortController();
  const onExternalAbort = (): void => internalAbort.abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    internalAbort.abort();
  }, timeoutMs);

  try {
    let full: PointCloud;
    try {
      // Race rather than await-then-check: a decode with no internal
      // cancellation point (the Node inline fallback `decodeFullViaWorker`
      // takes when no Worker exists) would otherwise ignore the deadline
      // entirely. In the real worker-backed browser path the abort also
      // terminates the worker, so the race and the signal agree.
      full = await Promise.race([
        decodeFn(buffer, name, internalAbort.signal),
        new Promise<never>((_, reject) => {
          internalAbort.signal.addEventListener('abort', () => reject(new Error('withheld-gather: aborted')));
        }),
      ]);
    } catch {
      return null;
    }
    if (options.signal?.aborted || timedOut) return null;

    const totalPoints = full.pointCount;
    if (totalPoints <= 0) return null;

    const staticBuffer: TerrainStreamBuffer = {
      pos: full.positions,
      cls: full.classification,
      flags: full.classificationFlags,
    };
    const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
    const sample = sampleStridedTerrain(
      [staticBuffer],
      [],
      totalPoints,
      maxPoints,
      full.classification != null,
    );
    if (!sample) return null;

    return { sample, totalPoints };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export interface WithheldAwareTerrainCoreResult {
  readonly core: TerrainCore;
  readonly sample: StridedTerrainSample;
  readonly totalPoints: number;
}

/**
 * {@link gatherWithheldAwareTerrainSource}, then rasterise the recovered
 * sample into a `TerrainCore` through the same `computeTerrainCore` path
 * every other DTM in this application is built with, so a recovered DTM's
 * cells are byte-identical to what a direct gather over the same
 * non-Withheld source points would produce, not a parallel computation that
 * merely agrees by construction.
 *
 * `coreParams` is the caller's interval-independent params (cell size, CRS,
 * unit facts, …) MINUS `classification`/`withheldExcluded`/
 * `withheldExcludedCount`, which this function fills in from the recovered
 * sample so a caller cannot accidentally pass stale ones from the display
 * gather.
 */
export async function gatherWithheldAwareTerrainCore(
  buffer: ArrayBuffer,
  name: string,
  coreParams: Omit<TerrainCoreParams, 'classification' | 'withheldExcluded' | 'withheldExcludedCount'>,
  options: WithheldAwareGatherOptions = {},
): Promise<WithheldAwareTerrainCoreResult | null> {
  const gathered = await gatherWithheldAwareTerrainSource(buffer, name, options);
  if (!gathered) return null;
  const { sample, totalPoints } = gathered;
  const core = computeTerrainCore(sample.positions, {
    ...coreParams,
    classification: sample.classification,
    withheldExcluded: sample.withheldExcluded,
    withheldExcludedCount: sample.withheldExcludedCount,
    // The re-decode strided the full-resolution source down to `maxPoints`
    // whenever the source held more than that; `sample.sampled` is exactly
    // that fact and must override `coreParams.sampled`, not merge under it,
    // since a caller building `coreParams` from the (unsampled) display
    // gather cannot know what THIS re-decode did.
    sampled: sample.sampled,
  });
  return { core, sample, totalPoints };
}
