/**
 * computeTerrainCoreAsync.ts
 *
 * The bridge between the cache/run path and the terrain-core worker, with a
 * SAFE main-thread fallback. {@link computeTerrainCoreAsync} tries to run the
 * heavy {@link computeTerrainCore} in a dedicated worker; on ANY worker failure
 * — construction error, worker `onerror`, an unsupported environment, or a
 * computation error reported by the worker — it falls back to running
 * {@link computeTerrainCore} synchronously on the main thread.
 *
 * This guarantees analysis still works even where the worker can't load (e.g.
 * if the bundle's worker chunk fails to resolve), which matters because the
 * worker round-trip can't be verified in the build/test sandbox — only the
 * fallback, cache, and abort logic can. The fallback is therefore the
 * correctness backbone, the worker the responsiveness optimization.
 *
 * Cancellation: an aborted signal short-circuits BEFORE any compute (worker or
 * fallback) so a superseded run / dataset change does no work. The worker
 * client also drops a late reply for an aborted job.
 *
 * Visibility (verification-only, no behaviour change): a REAL worker failure is
 * announced via `console.warn` BEFORE the fallback (so a broken worker can't
 * hide behind the still-working main-thread path), while an abort stays silent.
 * The path taken is also recorded — read it via {@link getLastTerrainComputePath}
 * — and the success path emits a dev-only `console.info` gated behind `?debug`.
 */

import {
  computeTerrainCore,
  type TerrainCore,
  type TerrainCoreParams,
} from '../contour/analyseContours';

/** The minimal worker-client surface {@link computeTerrainCoreAsync} drives. */
export interface TerrainCoreClientLike {
  computeCore(
    positions: Float32Array,
    n: number,
    coreParams: TerrainCoreParams,
    classification: ReadonlyArray<number> | Uint8Array | undefined,
    signal?: AbortSignal,
  ): Promise<TerrainCore>;
}

/** True when this thrown/rejected value is an abort (not a worker failure). */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /abort/i.test(msg);
}

/**
 * Which thread last computed a terrain core: `'worker'` when the off-thread
 * path succeeded, `'fallback'` when a worker failure forced the synchronous
 * main-thread path. This is verification-only instrumentation — a developer
 * (or the debug overlay) can read it to tell "ran off-thread" from "silently
 * fell back" without changing any compute behaviour.
 */
export type TerrainComputePath = 'worker' | 'fallback';

/**
 * Hard ceiling for the synchronous main-thread fallback. Production callers
 * stride to ≤ 300 000 points before reaching this module, so the limit is
 * future-proofing, not a live constraint — see the guard in
 * {@link computeTerrainCoreAsync} for the rationale.
 */
export const MAX_FALLBACK_POINTS = 1_000_000;

let lastComputePath: TerrainComputePath | null = null;

/** The path taken by the most recent {@link computeTerrainCoreAsync} call. */
export function getLastTerrainComputePath(): TerrainComputePath | null {
  return lastComputePath;
}

/**
 * Dev-flag check, mirroring the app's `?debug` convention (see `main.ts` /
 * `usageCounters.ts`). Gates the success-path `console.info` so normal users
 * see no console noise; failures are logged unconditionally (see below).
 * Load-safe in Node/SSR — returns false when there is no `window`.
 */
function debugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('debug');
  } catch {
    return false;
  }
}

// The lazily-constructed singleton worker client. Built on first successful
// use; left null until then so importing this module never constructs a Worker.
// Tests inject their own client via the `client` argument and never touch this.
let sharedClient: TerrainCoreClientLike | null = null;

/**
 * Factory for the real worker client, dynamically imported so this module — and
 * everything that imports it — stays loadable in Node (no top-level `Worker`).
 * Overridable in tests, though tests prefer passing an explicit `client`.
 */
let clientFactory: (() => Promise<TerrainCoreClientLike>) | null = null;

/** Replace the worker-client factory (tests / wiring). Pass null to reset. */
export function setTerrainCoreClientFactory(
  factory: (() => Promise<TerrainCoreClientLike>) | null,
): void {
  clientFactory = factory;
  sharedClient = null;
}

/** Default factory: dynamic-import the browser worker client. */
async function defaultClientFactory(): Promise<TerrainCoreClientLike> {
  const { TerrainCoreWorkerClient } = await import('./terrainCoreWorkerClient');
  return new TerrainCoreWorkerClient();
}

async function getSharedClient(): Promise<TerrainCoreClientLike> {
  if (sharedClient) return sharedClient;
  const factory = clientFactory ?? defaultClientFactory;
  sharedClient = await factory();
  return sharedClient;
}

/**
 * Compute a terrain core, off the main thread when possible. Tries the worker;
 * on any worker failure falls back to the synchronous {@link computeTerrainCore}
 * on the main thread. An aborted signal rejects without computing.
 *
 * @param positions XYZ triples (length 3·n). NOT detached — the client copies it.
 * @param n         Point count.
 * @param coreParams Interval-INDEPENDENT core params (may carry classification).
 * @param classification Optional per-point classification (also accepted on
 *   `coreParams.classification`; this explicit arg takes precedence).
 * @param signal    Cancellation signal.
 * @param client    Optional injected client (tests); defaults to the shared one.
 */
export async function computeTerrainCoreAsync(
  positions: Float32Array,
  n: number,
  coreParams: TerrainCoreParams,
  classification?: ReadonlyArray<number> | Uint8Array,
  signal?: AbortSignal,
  client?: TerrainCoreClientLike,
): Promise<TerrainCore> {
  if (signal?.aborted) {
    throw new DOMException('Terrain analysis aborted', 'AbortError');
  }
  const effectiveClassification = classification ?? coreParams.classification;
  // Keep classification ON the params for the fallback path (the synchronous
  // core reads coreParams.classification directly).
  const fallbackParams: TerrainCoreParams =
    effectiveClassification !== undefined
      ? { ...coreParams, classification: effectiveClassification }
      : coreParams;

  try {
    const c = client ?? (await getSharedClient());
    const core = await c.computeCore(positions, n, coreParams, effectiveClassification, signal);
    // Off-thread success. Record the path; dev-log only under `?debug`.
    lastComputePath = 'worker';
    if (debugEnabled()) console.info('[terrain] core computed via worker');
    return core;
  } catch (err) {
    // A genuine abort is not a worker failure — propagate it so the caller's
    // stale-result guard treats the run as cancelled rather than silently
    // recomputing on the main thread. Stay SILENT: an abort is expected.
    if (isAbortError(err)) throw err;
    // Any other worker failure is a REAL failure the developer must see — even
    // in production, because the fallback otherwise hides it (the app keeps
    // working, on the main thread, with no signal). Announce it unconditionally
    // BEFORE falling back so "off-thread success" can't be mistaken for "silent
    // main-thread fallback".
    // Include the point count: the fallback runs computeTerrainCore SYNCHRONOUSLY
    // on the main thread, so a large n here is the signal for a UI stall — the
    // one diagnostic a developer needs to tell "worker glitch on a small scan"
    // from "main-thread freeze on a big one".
    console.warn(`[terrain] worker analysis failed; fell back to main thread (${n} pts):`, err);
    // SAFE main-thread fallback. The compute is synchronous; re-check the
    // signal first so a cancelled run does no work.
    if (signal?.aborted) {
      throw new DOMException('Terrain analysis aborted', 'AbortError');
    }
    // Ceiling on the synchronous fallback. Every production caller routes
    // through `gatherTerrainPositions()` which strides to ≤ 300 000 points,
    // so this never fires today — it exists to protect FUTURE callers (e.g.
    // a full-resolution analysis path) from silently freezing the main
    // thread when the worker is unavailable. 1M points keeps generous
    // headroom over the current cap while still bounding the stall.
    if (n > MAX_FALLBACK_POINTS) {
      throw new Error(
        `Terrain worker unavailable and the dataset (${n} points) is too ` +
          `large to analyse safely on the main thread (limit ` +
          `${MAX_FALLBACK_POINTS}). Reload to restore the worker, or reduce ` +
          `the analysis sample size.`,
      );
    }
    const core = computeTerrainCore(positions, fallbackParams);
    lastComputePath = 'fallback';
    if (debugEnabled()) console.info('[terrain] core computed via main thread (fallback)');
    return core;
  }
}
