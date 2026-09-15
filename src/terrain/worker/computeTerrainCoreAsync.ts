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
 * The fallback is BOUNDED by measurement. It runs only for a workload small
 * enough to finish in about 200 ms on the main thread (see
 * {@link MAX_FALLBACK_POINTS} / {@link MAX_FALLBACK_CELLS} and
 * docs/validation/sync-fallback-budget-baseline.json). Anything larger is
 * refused with a {@link SyncFallbackRefusedError}, which states that nothing
 * was produced and what to do, rather than freezing the page for seconds.
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
import {
  SyncFallbackRefusedError,
  syncFallbackLimitsApply,
} from '../../workers/syncFallbackRefusedError';

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
 * Ceiling for the synchronous main-thread fallback, in points. MEASURED, not
 * assumed: `tests/benchmark/terrainCoreSyncFallbackBudget.test.ts` times
 * `computeTerrainCore` down a point ladder at a fixed 625-cell grid and the
 * curve crosses 200 ms between 100 000 and 200 000 points; the corner case
 * (this limit together with {@link MAX_FALLBACK_CELLS}) measures 195 ms. The
 * frozen rows live in docs/validation/sync-fallback-budget-baseline.json.
 */
export const MAX_FALLBACK_POINTS = 25_000;

/**
 * Ceiling for the synchronous main-thread fallback, in DTM grid cells. The
 * point count alone does not bound the cost: a sparse cloud over a fine grid
 * spends nearly all of its time filling voids, and the same ladder measures
 * 2 000 points over 250 000 cells at 48 s while 2 000 points over 1 024 cells
 * take 194 ms. The estimate below multiplies the two extent spans, so a scan
 * that would rasterise past this many cells is refused whatever its size.
 */
export const MAX_FALLBACK_CELLS = 1_000;

/** Per-call overrides for the fallback ceilings (tests). */
export interface TerrainFallbackLimits {
  readonly maxSyncFallbackPoints?: number;
  readonly maxSyncFallbackCells?: number;
  /**
   * Force the ceilings on or off. Defaults to {@link syncFallbackLimitsApply},
   * which is true in a browser (where a long synchronous compute freezes the
   * page) and false in Node (where the fallback is the only compute path).
   */
  readonly enforceLimits?: boolean;
}

/**
 * Estimated DTM grid cells for this cloud: the XY extent of the first `n`
 * points divided by the cell size, per axis. Cheap (one linear pass, no
 * allocation) and deliberately independent of the terrain core, so the refusal
 * can be decided BEFORE any grid is built. Returns null when the extent is not
 * finite or the cell size is not usable, so an unknown estimate never refuses.
 */
export function estimateTerrainCells(
  positions: Float32Array,
  n: number,
  cellSizeM: number,
): number | null {
  if (!Number.isFinite(cellSizeM) || cellSizeM <= 0) return null;
  const count = Math.min(Math.max(0, Math.floor(n)), Math.floor(positions.length / 3));
  if (count <= 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSizeM));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cellSizeM));
  return cols * rows;
}

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
  opts?: TerrainFallbackLimits,
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
    // so "off-thread success" can't be mistaken for "silent main-thread
    // fallback" — but DON'T claim the fallback yet: the ceiling check below may
    // refuse it and throw, so "fell back to main thread" here would be a lie on
    // an over-limit dataset.
    // Include the point count: the fallback runs computeTerrainCore SYNCHRONOUSLY
    // on the main thread, so a large n here is the signal for a UI stall — the
    // one diagnostic a developer needs to tell "worker glitch on a small scan"
    // from "main-thread freeze on a big one".
    console.warn(`[terrain] worker analysis failed (${n} pts):`, err);
    // SAFE main-thread fallback. The compute is synchronous; re-check the
    // signal first so a cancelled run does no work.
    if (signal?.aborted) {
      throw new DOMException('Terrain analysis aborted', 'AbortError');
    }
    // Ceilings on the synchronous fallback, both measured (see the constants).
    // The worker is gone, so the only choice left is "freeze the page" or "say
    // nothing was produced". Above either bound the honest answer is the
    // refusal, which the runner surfaces as a failed analysis.
    const enforce = opts?.enforceLimits ?? syncFallbackLimitsApply();
    const maxPoints = opts?.maxSyncFallbackPoints ?? MAX_FALLBACK_POINTS;
    const maxCells = opts?.maxSyncFallbackCells ?? MAX_FALLBACK_CELLS;
    if (enforce && n > maxPoints) {
      throw new SyncFallbackRefusedError({ stage: 'terrain', points: n, limit: maxPoints });
    }
    const cells = enforce ? estimateTerrainCells(positions, n, fallbackParams.cellSizeM) : null;
    if (cells !== null && cells > maxCells) {
      throw new SyncFallbackRefusedError({
        stage: 'terrain',
        points: n,
        limit: maxCells,
        measure: 'cells',
      });
    }
    // The ceiling passed — the fallback is actually happening now.
    if (debugEnabled()) console.info(`[terrain] falling back to main thread (${n} pts)`);
    const core = computeTerrainCore(positions, fallbackParams);
    lastComputePath = 'fallback';
    if (debugEnabled()) console.info('[terrain] core computed via main thread (fallback)');
    return core;
  }
}
