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
    return await c.computeCore(positions, n, coreParams, effectiveClassification, signal);
  } catch (err) {
    // A genuine abort is not a worker failure — propagate it so the caller's
    // stale-result guard treats the run as cancelled rather than silently
    // recomputing on the main thread.
    if (isAbortError(err)) throw err;
    // Any other worker failure → SAFE main-thread fallback. The compute is
    // synchronous; re-check the signal first so a cancelled run does no work.
    if (signal?.aborted) {
      throw new DOMException('Terrain analysis aborted', 'AbortError');
    }
    return computeTerrainCore(positions, fallbackParams);
  }
}
