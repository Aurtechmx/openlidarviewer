/**
 * persistentCoreKey.ts
 *
 * The identity + invalidation contract a *persistent* (across-reopen) terrain
 * core cache must satisfy — the "Phase-0.5" library increment behind the
 * recompute-vs-reuse gate in `tests/benchmark/terrainCoreRebuildCost.test.ts`.
 *
 * It deliberately stops short of any storage: no OPFS, no serialization of the
 * core, no reopen wiring. The gate's own condition — "a browser measurement of
 * real OPFS read + deserialization must confirm before any storage code is
 * written" — still stands. What this module provides is the part that is pure,
 * deterministic and fully Node-testable *now*: how a persisted core would be
 * keyed, and exactly which input changes must force a miss.
 *
 * It differs from the in-memory {@link coreFingerprint} in two ways that only
 * matter once a core outlives the process that computed it:
 *
 *   1. Source identity is a full SHA-256 of the position bytes, not the sampled
 *      64-bit FNV the in-memory cache uses. The FNV sample hash is safe only
 *      because `clearTerrainCoreCache()` scopes reuse to one open scan, where
 *      the cloud is literally the same array; a persisted core is looked up
 *      against a *freshly loaded* cloud, so a sample-collision would serve the
 *      wrong terrain. A full digest removes that risk (collision here = a
 *      cryptographic SHA-256 collision, not a sampling coincidence).
 *
 *   2. The key folds in a *method generation* — the id@version tag of every
 *      registered method whose output is baked into a {@link TerrainCore}. The
 *      in-memory cache can omit this because code cannot change mid-process; a
 *      persisted core survives a deploy, so a method version bump must force a
 *      miss or old-code science would be served silently. This mirrors the OOC
 *      point cache's `cacheGeneration()`.
 *
 * The param-invalidation half is NOT re-implemented here: it reuses
 * {@link paramsKey} verbatim, so the persistent key can never drift from the
 * param coverage the in-memory cache already proves in `terrainCoreCache.test.ts`.
 */

import { methodRef, type MethodRef } from '../../science/methodRegistry';

import { paramsKey } from './terrainCoreCache';
import type { TerrainCoreParams } from './analyseContours';

/**
 * Bumped when the persistent key's own scheme changes (field order, digest
 * input, generation format) in a way that must not match keys written under an
 * older scheme. Independent of the method versions folded into the generation.
 */
export const PERSISTENT_CORE_KEY_VERSION = 1;

/**
 * The registered methods whose output is baked into an interval-INDEPENDENT
 * {@link TerrainCore}. If any of these bumps its registry version, a core
 * persisted under the old version is stale and must miss.
 *
 * Interval-stage methods (`olv.contour.*`) are deliberately excluded — they run
 * *after* the core and are not part of it, exactly as the interval is excluded
 * from {@link paramsKey}. Registration/volume/topology/feature methods are
 * excluded because they are not inputs to the terrain core.
 *
 * Each id is asserted to exist in the registry by the accompanying test, so a
 * rename breaks loudly rather than silently dropping a method from the key.
 */
export const TERRAIN_CORE_METHOD_IDS: readonly string[] = [
  'olv.ground.smrf',
  'olv.class.derived-heuristic',
  'olv.dtm.idw-fill',
  'olv.terrain.slope-horn',
  'olv.terrain.vrm',
  'olv.terrain.tpi',
  'olv.validation.holdout-rmse',
  'olv.validation.spatial-block',
  'olv.validation.reliability-wilson',
];

/** Looks up a method's current registry version. Injectable for tests. */
export type MethodVersionLookup = (id: string) => number;

const registryVersion: MethodVersionLookup = (id) => methodRef(id).version;

/**
 * The core method generation: `id@version` for every {@link TERRAIN_CORE_METHOD_IDS}
 * entry, ordered by id for stability, prefixed with the key-scheme version. A
 * bump to any folded method's version — or to {@link PERSISTENT_CORE_KEY_VERSION}
 * — changes this string, which changes every persistent key derived from it.
 *
 * `versionOf` defaults to the live registry; pass a custom lookup to model a
 * version bump in a test without mutating the registry.
 */
export function coreMethodGeneration(
  versionOf: MethodVersionLookup = registryVersion,
): string {
  const tags = [...TERRAIN_CORE_METHOD_IDS]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => {
      const ref: MethodRef = { id, version: versionOf(id) };
      return `${ref.id}@${ref.version}`;
    });
  return `k${PERSISTENT_CORE_KEY_VERSION};${tags.join(',')}`;
}

/** Render a digest ArrayBuffer as lowercase hex. */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** SHA-256 of raw bytes, as lowercase hex. Uses the platform WebCrypto (browser
 *  and Node 18+), matching the OOC file fingerprint. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view so `digest` hashes exactly these
  // bytes (never a pooled buffer's neighbours) and the type is a plain
  // ArrayBuffer, not the SharedArrayBuffer the generic Uint8Array admits.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
  return toHex(digest);
}

/**
 * Cross-session-safe content identity for a position cloud: a full SHA-256 over
 * the raw XYZ bytes, folded with the triple count so a truncation that leaves a
 * prefix identical still differs. Unlike the in-memory FNV sample hash this is
 * collision-free for practical purposes, which is what a persisted lookup
 * against a freshly loaded cloud requires.
 */
export async function cryptoContentFingerprint(positions: Float32Array): Promise<string> {
  const count = (positions.length / 3) | 0;
  const view = new Uint8Array(
    positions.buffer,
    positions.byteOffset,
    positions.byteLength,
  );
  const digest = await sha256Hex(view);
  return `n${count}.${digest}`;
}

/**
 * The persistent cache key for a (positions, core params) pair under a given
 * method generation: `contentFingerprint # paramsKey # generation`. All three
 * axes must match for a hit; a change in the cloud content, any core param, or
 * any folded method version yields a different key (a miss).
 *
 * `generation` defaults to the live {@link coreMethodGeneration}; it is a
 * parameter so a caller (or a test) can pin or vary it explicitly.
 */
export async function persistentCoreKey(
  positions: Float32Array,
  params: TerrainCoreParams,
  generation: string = coreMethodGeneration(),
): Promise<string> {
  const content = await cryptoContentFingerprint(positions);
  return `${content}#${paramsKey(params)}#${generation}`;
}

/**
 * Integrity digest of a serialized payload — the SHA-256 a persisted entry
 * would be verified against on read, so a truncated or corrupted blob is
 * rejected rather than deserialized into wrong science. Provided here (pure,
 * no storage) so the contract is testable before any storage code exists.
 */
export async function integrityDigest(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

/** True iff `bytes` still hashes to `expected`. A single flipped byte fails. */
export async function verifyIntegrity(
  bytes: Uint8Array,
  expected: string,
): Promise<boolean> {
  return (await integrityDigest(bytes)) === expected;
}
