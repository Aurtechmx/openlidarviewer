/**
 * bootTour.ts
 *
 * Boots the onboarding tour: builds the session, mounts the overlay so the
 * SVG / card DOM exists, and hands back the two entry points the app offers.
 *
 * The tour does NOT auto-start. It used to launch itself on the first visit,
 * which put a modal over the product before the visitor had seen anything —
 * the worst possible first moment. It is now offered twice and imposed never:
 * the splash's quiet "Take the 30-second tour" chip calls `start`, and the
 * command palette's "Replay onboarding tour" calls `replay`.
 */
import { TourOverlay } from './TourOverlay';
import { TourSession } from './tourSteps';

export interface TourHandle {
  /**
   * Start from the splash chip. The double rAF lets the layout settle
   * first — the spotlight bounding boxes land off-target when measured
   * against a still-positioning page.
   */
  readonly start: () => void;
  /** Restart immediately — the command-palette replay path. */
  readonly replay: () => void;
}

/** Build, mount, and wrap the tour. Call once at app boot. */
export function bootTour(): TourHandle {
  const session = new TourSession();
  const overlay = new TourOverlay(session);
  overlay.mount();
  return {
    start: () => {
      session.reset();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => session.start());
      });
    },
    replay: () => {
      session.reset();
      session.start();
    },
  };
}
