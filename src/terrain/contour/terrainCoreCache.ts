/**
 * terrainCoreCache.ts
 *
 * A tiny, fingerprint-keyed LRU cache for the interval-INDEPENDENT terrain
 * "core" ({@link computeTerrainCore}). The heavy half of the contour pipeline
 * — classification, ground filter, DTM raster + hardening, void fill, hold-out
 * validation, confidence calibration, the interval gate, quality + scoring and
 * the surface models — depends only on the points + {@link TerrainCoreParams}.
 * Nothing in it reads the contour interval. So when the user re-picks a contour
 * interval, or re-opens the Analyse panel, or re-runs Analyse on the same scan,
 * the core can (and should) be reused and only the cheap interval stage rerun.
 *
 * This module is the cache that makes that reuse possible: key a core by a
 * stable fingerprint of (positions content + length, core params); return the
 * cached core on a fingerprint match; otherwise compute + store, evicting the
 * least-recently-used entry once the (small) capacity is reached.
 *
 * Pure / deterministic / no DOM. The compute function is injectable so the
 * cache can be tested without running the (slow) real pipeline.
 *
 * --- Fingerprint design + collision tradeoff ---
 *
 * A point cloud can be millions of triples; hashing every coordinate on every
 * Analyse / interval pick would defeat the purpose of caching. Instead the
 * content hash is a *sample* hash: a 64-bit FNV-1a folded over
 *   - the cloud length (so two clouds of different size never collide),
 *   - the first and last XYZ triples (cheap, catches most edits at the ends),
 *   - and a fixed-stride set of interior samples (so an edit in the middle is
 *     very likely to change the hash).
 * The sample count is capped, so the cost is O(SAMPLES), independent of N.
 *
 * This is a heuristic, NOT a cryptographic identity. Two *different* clouds
 * that happen to share length, endpoints AND every sampled interior triple
 * would collide and the cache would serve the wrong core. In practice that is
 * vanishingly unlikely for real scans (independent captures differ at the
 * sampled positions), and the cost of a hypothetical collision is bounded: the
 * UI would render a terrain surface for the wrong-but-near-identical cloud. To
 * keep that risk irrelevant in the app, the caller ALSO calls
 * {@link clearTerrainCoreCache} whenever a scan is closed or a new one is
 * loaded — so a core is only ever reused within the lifetime of one open scan,
 * where the cloud genuinely is the same array. The fingerprint then only has to
 * distinguish *parameter* changes (cell size, ground, CRS, classification, …),
 * which it does exactly.
 */

import {
  computeTerrainCore,
  type TerrainCore,
  type TerrainCoreParams,
  type TerrainPointInput,
} from './analyseContours';

// Re-export the interval stage through this module so a caller that has the
// cache chunk loaded can run the cheap contour stage WITHOUT a second dynamic
// import of the analysis module — both live in the same lazy chunk.
export { contoursFromCore } from './analyseContours';
export type {
  TerrainCore,
  TerrainCoreParams,
  IntervalContourParams,
  AnalyseContoursResult,
} from './analyseContours';

/**
 * Maximum number of distinct cores held at once. Small on purpose: the common
 * working set is one scan at a time, occasionally toggling a couple of
 * parameter variants (e.g. cell size) back and forth. Each core holds full DTM
 * + surface grids, so the cache is kept tiny to bound memory.
 */
export const TERRAIN_CORE_CACHE_SIZE = 3;

/** Number of interior samples folded into the content hash (cost is O(this)). */
const CONTENT_SAMPLES = 64;

/**
 * Number of interior classification samples folded into the param key (cost is
 * O(this)). Mirrors {@link CONTENT_SAMPLES}: bounded, independent of N.
 */
const CLASS_SAMPLES = 64;

// 64-bit FNV-1a constants, run as two 32-bit halves so the math stays exact in
// JS doubles (no BigInt needed; >>> 0 keeps each lane 32-bit).
const FNV_OFFSET_LO = 0x84222325;
const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_PRIME_LO = 0x000001b3;
const FNV_PRIME_HI = 0x00000100;

/** A running 64-bit FNV-1a state as a pair of 32-bit lanes. */
interface Fnv64 {
  lo: number;
  hi: number;
}

function fnvInit(): Fnv64 {
  return { lo: FNV_OFFSET_LO, hi: FNV_OFFSET_HI };
}

/** Fold one 32-bit word into the running 64-bit FNV-1a hash, in place. */
function fnvMix(h: Fnv64, word: number): void {
  // XOR the low lane with the incoming word (FNV-1a hashes octets; folding a
  // whole 32-bit word at a time is a cheap, well-distributed variant that is
  // sufficient for a non-cryptographic content fingerprint).
  h.lo = (h.lo ^ (word >>> 0)) >>> 0;
  // 64-bit multiply by the FNV prime, done as two 32-bit lanes.
  const aLo = h.lo;
  const aHi = h.hi;
  // Schoolbook 32x32 -> 64 across lanes (only the low 64 bits are kept).
  const loLo = (aLo & 0xffff) * FNV_PRIME_LO;
  const loHi = (aLo >>> 16) * FNV_PRIME_LO;
  const hiLo = (aLo & 0xffff) * FNV_PRIME_HI;
  let cross = (loHi & 0xffff) + (hiLo & 0xffff);
  let newLo = (loLo + ((cross & 0xffff) << 16)) >>> 0;
  let newHi =
    (aHi * FNV_PRIME_LO +
      aLo * FNV_PRIME_HI +
      (loHi >>> 16) +
      (hiLo >>> 16) +
      (cross >>> 16)) >>>
    0;
  h.lo = newLo >>> 0;
  h.hi = newHi >>> 0;
}

/** Fold a float into the hash by its raw 32-bit bit pattern. */
function fnvMixFloat(h: Fnv64, scratch: Float32Array, value: number): void {
  scratch[0] = value;
  // Reinterpret the float32 bits as a uint32 via a shared buffer view.
  fnvMix(h, new Uint32Array(scratch.buffer)[0]);
}

/** Render the 64-bit hash as a fixed-width hex string. */
function fnvHex(h: Fnv64): string {
  return (
    (h.hi >>> 0).toString(16).padStart(8, '0') +
    (h.lo >>> 0).toString(16).padStart(8, '0')
  );
}

/**
 * Cheap, stride-sampled 64-bit content hash of an XYZ-triple Float32Array.
 * Folds the length, the first and last triples, and up to {@link CONTENT_SAMPLES}
 * evenly-spaced interior triples. Cost is O(CONTENT_SAMPLES), independent of N.
 */
function contentHash(positions: Float32Array): string {
  const h = fnvInit();
  const scratch = new Float32Array(1);
  const len = positions.length;
  // Length first — two clouds of different size can never collide.
  fnvMix(h, len >>> 0);
  if (len === 0) return fnvHex(h);

  const triples = (len / 3) | 0;
  // First + last triple — cheap and catches the most common end edits.
  for (let k = 0; k < 3 && k < len; k++) fnvMixFloat(h, scratch, positions[k]);
  const lastBase = (triples - 1) * 3;
  for (let k = 0; k < 3; k++) fnvMixFloat(h, scratch, positions[lastBase + k]);

  // Interior samples at a fixed stride (capped count → bounded cost).
  const sampleCount = Math.min(CONTENT_SAMPLES, triples);
  if (sampleCount > 1) {
    const stride = Math.max(1, Math.floor(triples / sampleCount));
    for (let t = 0; t < triples; t += stride) {
      const base = t * 3;
      fnvMixFloat(h, scratch, positions[base]);
      fnvMixFloat(h, scratch, positions[base + 1]);
      fnvMixFloat(h, scratch, positions[base + 2]);
    }
  }
  return fnvHex(h);
}

/**
 * Cheap, stride-sampled 64-bit hash of the per-point classification CONTENT.
 * The classification can be edited IN PLACE (reclassify / undo) without the
 * positions array or the classification length changing, so presence + length
 * alone do NOT distinguish a re-classified cloud — its content must be keyed or
 * a stale bare-earth core would be served on the next Analyse run. This folds
 * the length, the first and last values, and up to {@link CLASS_SAMPLES}
 * evenly-spaced interior values BY INTEGER VALUE (works for both
 * `ReadonlyArray<number>` and `Uint8Array`). Cost is O(CLASS_SAMPLES).
 */
function classificationHash(
  classification: ReadonlyArray<number> | Uint8Array,
): string {
  const h = fnvInit();
  const len = classification.length;
  fnvMix(h, len >>> 0);
  if (len === 0) return fnvHex(h);

  // First + last value — cheap and catches the most common end edits.
  fnvMix(h, classification[0] >>> 0);
  fnvMix(h, classification[len - 1] >>> 0);

  // Interior samples at a fixed stride (capped count → bounded cost).
  const sampleCount = Math.min(CLASS_SAMPLES, len);
  if (sampleCount > 1) {
    const stride = Math.max(1, Math.floor(len / sampleCount));
    for (let i = 0; i < len; i += stride) {
      fnvMix(h, classification[i] >>> 0);
    }
  }
  return fnvHex(h);
}

/**
 * Serialise the interval-INDEPENDENT core params into a stable, order-fixed
 * string. Every field {@link computeTerrainCore} reads is included; the contour
 * interval and other interval-stage options are deliberately excluded, so an
 * interval change keeps the same key (and reuses the core).
 *
 * Ground overrides are flattened in a fixed field order (not JSON of the object,
 * whose key order is not guaranteed to be stable across callers).
 *
 * Classification contributes presence + length AND a cheap sampled hash of its
 * CONTENT (see {@link classificationHash}). Content matters because the core
 * drops vegetation / building / noise returns before ground filtering, so the
 * bare-earth surface genuinely depends on the class values — and those values
 * can be edited IN PLACE (reclassify / undo) while the positions array and the
 * classification length stay unchanged. Keying only presence + length would let
 * such an edit reuse a stale core and silently emit the wrong DTM.
 */
function paramsKey(params: TerrainCoreParams): string {
  const g = params.ground;
  const ground = g
    ? [
        g.maxWindowCells ?? '',
        g.slope ?? '',
        g.elevationThresholdM ?? '',
        g.scalingFactorM ?? '',
        g.floorPercentile ?? '',
      ].join(',')
    : '';
  const exclude = params.excludeClasses ? Array.from(params.excludeClasses).join('.') : '';
  // Presence + length + a cheap sampled CONTENT hash, so an in-place
  // reclassify (same array/length) changes the key and forces a recompute.
  const classPresence = params.classification
    ? `1:${params.classification.length}:${classificationHash(params.classification)}`
    : '0';
  return [
    `cs=${params.cellSizeM}`,
    `crs=${params.crs ?? ''}`,
    `geo=${params.isGeographic ? 1 : 0}`,
    `v2m=${params.verticalUnitToMetres ?? ''}`,
    `vd=${params.verticalDatum ?? ''}`,
    `va=${params.verticalAxis ?? ''}`,
    `cls=${classPresence}`,
    `exc=${exclude}`,
    `seed=${params.holdoutSeed ?? ''}`,
    `g=${ground}`,
  ].join('|');
}

/**
 * Stable cache key for a (positions, core params) pair: the cheap sampled
 * content hash + the exact core-param serialisation. See the module header for
 * the collision tradeoff.
 */
export function coreFingerprint(
  positions: Float32Array,
  params: TerrainCoreParams,
): string {
  return `${contentHash(positions)}#${paramsKey(params)}`;
}

/**
 * The compute function the cache calls on a miss. Defaults to the real
 * {@link computeTerrainCore}; injectable for tests. Accepts the same
 * {@link TerrainPointInput} the pipeline accepts (the app passes a
 * Float32Array).
 */
export type ComputeCoreFn = (
  input: TerrainPointInput,
  params: TerrainCoreParams,
) => TerrainCore;

// Insertion-ordered map → cheapest possible LRU: a Map preserves insertion
// order, so the first key is the least-recently-used and re-inserting on a hit
// moves a key to the most-recent end.
const cache = new Map<string, TerrainCore>();

/**
 * Return the cached {@link TerrainCore} for these positions + core params, or
 * compute it (via `compute`, default {@link computeTerrainCore}), store it, and
 * return it. On a hit the entry is refreshed to most-recently-used; on a miss
 * past capacity the least-recently-used entry is evicted.
 *
 * The interval is NOT part of the key, so repeated interval picks on the same
 * scan + params all reuse the one computed core.
 */
export function getOrComputeCore(
  positions: Float32Array,
  params: TerrainCoreParams,
  compute: ComputeCoreFn = computeTerrainCore,
): TerrainCore {
  const key = coreFingerprint(positions, params);
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency: delete + re-set moves the key to the most-recent end.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const core = compute(positions, params);
  cache.set(key, core);
  // Evict the least-recently-used entries (front of the Map) past capacity.
  while (cache.size > TERRAIN_CORE_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return core;
}

/**
 * The async compute function the cache calls on a miss in
 * {@link getOrComputeCoreAsync}. Returns a Promise of the core so the compute
 * can run in a worker (with main-thread fallback). Injectable for tests.
 */
export type ComputeCoreAsyncFn = (
  input: TerrainPointInput,
  params: TerrainCoreParams,
) => Promise<TerrainCore>;

// In-flight computes keyed by fingerprint, so two near-simultaneous misses for
// the SAME key (e.g. a re-run while the first is still computing) share one
// compute instead of spawning two worker jobs. The entry is cleared once the
// promise settles; only a fulfilled result is stored in the LRU.
const inFlight = new Map<string, Promise<TerrainCore>>();

/**
 * Async sibling of {@link getOrComputeCore}: return the cached core for these
 * positions + core params, or AWAIT `compute` (which may run in a worker), store
 * the result, and return it. Cache semantics are identical to the sync path —
 * a hit never calls `compute`; a miss computes once and stores; the LRU evicts
 * past capacity.
 *
 * On a miss two extra guarantees hold:
 *   - Concurrent misses for the SAME key share one in-flight compute.
 *   - A rejected compute (including an aborted one) is NOT stored, so a later
 *     run recomputes rather than serving a failure.
 */
export async function getOrComputeCoreAsync(
  positions: Float32Array,
  params: TerrainCoreParams,
  compute: ComputeCoreAsyncFn,
): Promise<TerrainCore> {
  const key = coreFingerprint(positions, params);
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency: delete + re-set moves the key to the most-recent end.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  // Coalesce concurrent misses for the same key onto one compute.
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = compute(positions, params);
  inFlight.set(key, promise);
  let core: TerrainCore;
  try {
    core = await promise;
  } finally {
    // Always release the in-flight slot, success or failure.
    inFlight.delete(key);
  }
  // Store only on success (a rejection threw above and never reaches here).
  // Re-check: a clear() during the await must not resurrect a stale entry —
  // but a fresh store for the current key is correct, so just set + evict.
  cache.set(key, core);
  while (cache.size > TERRAIN_CORE_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return core;
}

/**
 * Drop every cached core. Called on dataset close / new-cloud load so a stale
 * core can never be served for a different scan and memory stays bounded.
 *
 * In-flight computes are also forgotten so a result that resolves after a clear
 * does not re-seed the cache for a since-closed scan; the resolving promise's
 * own caller still receives its value, it simply is not cached.
 */
export function clearTerrainCoreCache(): void {
  cache.clear();
  inFlight.clear();
}
