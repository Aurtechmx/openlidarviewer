/**
 * tourLauncher.ts
 *
 * A TourHandle whose chunk loads on first use.
 *
 * The onboarding tour used to boot eagerly so its overlay DOM existed before
 * either entry point could fire, which kept TourOverlay, tourSteps and their
 * SVG spotlight machinery in the index chunk of every visit. Nothing reads
 * that DOM until the splash chip or the palette's replay action runs, so the
 * launcher stands in for the handle and boots the real tour behind the first
 * call. Both entry points already tolerate a beat of latency: `start` settles
 * layout behind a double requestAnimationFrame before the first spotlight.
 *
 * Boot stays once-only. The first call wins the import; every later call
 * reuses the same booted session, so replay-after-start behaves exactly as it
 * did when the tour booted at startup.
 */
import type { TourHandle } from '../ui/onboarding/bootTour';
import { retryableOnce, runWithRetry, type LazyLoadToast } from './lazySurfaceLoad';

/** The shape of the lazy module the launcher boots. */
type TourModule = { bootTour: () => TourHandle };

/**
 * A real TourHandle that defers the tour chunk until start or replay. A failed
 * load reaches `toast` with a Try again that repeats the call, and the failure
 * is not kept: the next start or replay fetches the chunk again.
 */
export function createTourLauncher(load: () => Promise<TourModule>, toast: LazyLoadToast): TourHandle {
  const ensure = retryableOnce(() => load().then((m) => m.bootTour()));
  const call = (method: keyof TourHandle): void => runWithRetry(toast, () => ensure().then((t) => t[method]()), 'tour');
  return { start: () => call('start'), replay: () => call('replay') };
}
