/**
 * deriveClassificationAsync.ts
 *
 * Bridge between the UI and the classifier worker, with a SAFE main-thread
 * fallback. Tries the worker; on ANY worker failure (construction error,
 * onerror, unsupported environment, or a reported computation error) it runs
 * {@link deriveClassification} synchronously on the main thread.
 *
 * The fallback is BOUNDED by measurement: it runs only for a cloud small enough
 * to finish in about 200 ms on the main thread (see {@link MAX_FALLBACK_POINTS}
 * and docs/validation/sync-fallback-budget-baseline.json). Anything larger is
 * refused with a {@link SyncFallbackRefusedError} that states nothing was
 * changed, rather than freezing the page.
 *
 * This guarantees Classify still works where the worker chunk can't load, which
 * matters because the worker round-trip can't be verified in the build/test
 * sandbox — only the fallback, cache and abort logic can. The fallback is the
 * correctness backbone; the worker is the responsiveness optimisation.
 *
 * Mirrors `computeTerrainCoreAsync`: an aborted signal short-circuits before any
 * compute; a real worker failure is announced via console.warn before the
 * fallback (so a broken worker can't hide behind the still-working main-thread
 * path); an abort stays silent; the path taken is recorded for verification.
 */

import type {
  DeriveClassificationOptions,
  DeriveClassificationResult,
} from './deriveClassification';
import type { DeriveClassificationClientLike } from './deriveClassificationWorkerClient';
import {
  SyncFallbackRefusedError,
  syncFallbackLimitsApply,
} from '../../workers/syncFallbackRefusedError';

/** Which thread last derived a classification. Verification-only instrumentation. */
export type ClassifyComputePath = 'worker' | 'fallback';

/**
 * Ceiling for the synchronous main-thread fallback, in points. MEASURED, not
 * assumed: `tests/benchmark/deriveClassificationSyncFallbackBudget.test.ts`
 * times `deriveClassification` down a point ladder and the curve crosses 200 ms
 * at 1 000 000 points (169 ms there, 267 ms at 2 000 000). The frozen rows live
 * in docs/validation/sync-fallback-budget-baseline.json.
 */
export const MAX_FALLBACK_POINTS = 1_000_000;

/** Per-call override for the fallback ceiling (tests). */
export interface ClassifyFallbackLimits {
  readonly maxSyncFallbackPoints?: number;
  /**
   * Force the ceiling on or off. Defaults to {@link syncFallbackLimitsApply},
   * which is true in a browser (where a long synchronous compute freezes the
   * page) and false in Node (where the fallback is the only compute path).
   */
  readonly enforceLimits?: boolean;
}

let lastComputePath: ClassifyComputePath | null = null;

/** The path taken by the most recent {@link deriveClassificationAsync} call. */
export function getLastClassifyComputePath(): ClassifyComputePath | null {
  return lastComputePath;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /abort/i.test(msg);
}

function debugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('debug');
  } catch {
    return false;
  }
}

let sharedClient: DeriveClassificationClientLike | null = null;
let clientFactory: (() => Promise<DeriveClassificationClientLike>) | null = null;

/** Replace the worker-client factory (tests / wiring). Pass null to reset. */
export function setDeriveClassificationClientFactory(
  factory: (() => Promise<DeriveClassificationClientLike>) | null,
): void {
  clientFactory = factory;
  sharedClient = null;
}

async function defaultClientFactory(): Promise<DeriveClassificationClientLike> {
  const { DeriveClassificationWorkerClient } = await import('./deriveClassificationWorkerClient');
  return new DeriveClassificationWorkerClient();
}

async function getSharedClient(): Promise<DeriveClassificationClientLike> {
  if (sharedClient) return sharedClient;
  const factory = clientFactory ?? defaultClientFactory;
  sharedClient = await factory();
  return sharedClient;
}

/**
 * Derive a classification, off the main thread when possible. Tries the worker;
 * on any worker failure falls back to the synchronous {@link deriveClassification}.
 * An aborted signal rejects without computing.
 *
 * @param positions XYZ triples (length 3·n). NOT detached — the client copies it.
 * @param n         Point count.
 * @param options   Classifier options (all defaulted).
 * @param signal    Cancellation signal.
 * @param client    Optional injected client (tests); defaults to the shared one.
 */
export async function deriveClassificationAsync(
  positions: Float32Array,
  n: number,
  options: DeriveClassificationOptions = {},
  signal?: AbortSignal,
  client?: DeriveClassificationClientLike,
  onProgress?: (phase: string) => void,
  opts?: ClassifyFallbackLimits,
): Promise<DeriveClassificationResult> {
  if (signal?.aborted) {
    throw new DOMException('Classification aborted', 'AbortError');
  }
  try {
    const c = client ?? (await getSharedClient());
    const result = await c.classify(positions, n, options, signal, onProgress);
    lastComputePath = 'worker';
    if (debugEnabled()) console.info('[classify] derived via worker');
    return result;
  } catch (err) {
    if (isAbortError(err)) throw err;
    // Announce the worker failure unconditionally (a broken worker must never
    // hide behind the still-working main-thread path) — but DON'T claim a
    // fallback yet: the ceiling check below may refuse it. Saying "fell back"
    // here would lie whenever the dataset is over the limit and we throw.
    console.warn(`[classify] worker failed (${n} pts):`, err);
    if (signal?.aborted) {
      throw new DOMException('Classification aborted', 'AbortError');
    }
    const enforce = opts?.enforceLimits ?? syncFallbackLimitsApply();
    const maxPoints = opts?.maxSyncFallbackPoints ?? MAX_FALLBACK_POINTS;
    if (enforce && n > maxPoints) {
      throw new SyncFallbackRefusedError({ stage: 'classify', points: n, limit: maxPoints });
    }
    // The ceiling passed — the fallback is actually happening now.
    if (debugEnabled()) console.info(`[classify] falling back to main thread (${n} pts)`);
    // The synchronous fallback reports the same phases (best-effort, though it
    // blocks the main thread so the UI won't repaint between them).
    // Lazy: the classifier core (with its eigen-descriptor deps) is a heavy,
    // on-demand module — dynamic-import it here so it stays out of the eager
    // shell bundle. Same-origin chunk load, orthogonal to the worker failures
    // this fallback exists for.
    const { deriveClassification } = await import('./deriveClassification');
    const result = deriveClassification(positions, n, options, onProgress);
    lastComputePath = 'fallback';
    if (debugEnabled()) console.info('[classify] derived via main thread (fallback)');
    return result;
  }
}
