/**
 * deriveClassificationAsync.ts
 *
 * Bridge between the UI and the classifier worker, with a SAFE main-thread
 * fallback. Tries the worker; on ANY worker failure (construction error,
 * onerror, unsupported environment, or a reported computation error) it runs
 * {@link deriveClassification} synchronously on the main thread.
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

import {
  deriveClassification,
  type DeriveClassificationOptions,
  type DeriveClassificationResult,
} from './deriveClassification';
import type { DeriveClassificationClientLike } from './deriveClassificationWorkerClient';

/** Which thread last derived a classification. Verification-only instrumentation. */
export type ClassifyComputePath = 'worker' | 'fallback';

/**
 * Hard ceiling for the synchronous main-thread fallback. The neighbourhood +
 * morphology passes are O(n) over a bounded grid, but a multi-million-point
 * fallback would still stall the UI, so cap it and tell the user how to recover.
 */
export const MAX_FALLBACK_POINTS = 6_000_000;

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
    if (n > MAX_FALLBACK_POINTS) {
      throw new Error(
        `The classifier worker is unavailable and the dataset (${n} points) is ` +
          `too large to classify safely on the main thread (limit ` +
          `${MAX_FALLBACK_POINTS}). Reload to restore the worker.`,
      );
    }
    // The ceiling passed — the fallback is actually happening now.
    if (debugEnabled()) console.info(`[classify] falling back to main thread (${n} pts)`);
    // The synchronous fallback reports the same phases (best-effort, though it
    // blocks the main thread so the UI won't repaint between them).
    const result = deriveClassification(positions, n, options, onProgress);
    lastComputePath = 'fallback';
    if (debugEnabled()) console.info('[classify] derived via main thread (fallback)');
    return result;
  }
}
