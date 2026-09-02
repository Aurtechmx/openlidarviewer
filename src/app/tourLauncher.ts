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

/** The shape of the lazy module the launcher boots. */
type TourModule = { bootTour: () => TourHandle };

/** A real TourHandle that defers the tour chunk until start or replay. */
export function createTourLauncher(load: () => Promise<TourModule>): TourHandle {
  let booted: Promise<TourHandle> | null = null;
  const ensure = (): Promise<TourHandle> => (booted ??= load().then((m) => m.bootTour()));
  return {
    start: () => void ensure().then((t) => t.start()),
    replay: () => void ensure().then((t) => t.replay()),
  };
}
