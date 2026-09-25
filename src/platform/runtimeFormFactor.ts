/**
 * runtimeFormFactor.ts
 *
 * A generic runtime class decided from capability signals only (pointer, hover,
 * viewport). No user-agent strings, no device names.
 *
 *   - 'large-touch': coarse pointer with no hover, and the short viewport side
 *     is at least LARGE_TOUCH_MIN_SHORT_SIDE CSS px.
 *   - 'phone':       coarse pointer with no hover, smaller than that.
 *   - 'desktop':     everything else (a fine or hovering pointer).
 *   - 'embedded-field': reserved. Nothing here returns it. A static capability
 *     read cannot tell a field controller from a tablet; that takes a measured
 *     calibration showing constrained sustained capacity, which will promote a
 *     'large-touch' result to 'embedded-field' when it exists.
 *
 * Uses the short side, so portrait and landscape of the same screen classify
 * the same; call again after a resize (the result is not cached).
 */
import { isTouchFirstDevice } from '../ui/isMobileDevice';

export type RuntimeFormFactor = 'desktop' | 'phone' | 'large-touch' | 'embedded-field';

/** Short viewport side (CSS px) from which a touch-first screen is 'large-touch'. */
export const LARGE_TOUCH_MIN_SHORT_SIDE = 600;

/**
 * The CSS condition the large-touch LAYOUT rules use (src/styles/99-mobile-gui-refresh.css).
 * Narrower than the 'large-touch' class above: below 768 px wide the phone layout
 * (MOBILE_LAYOUT_QUERY) owns the screen, so only a touch-first screen that also
 * gets the desktop workspace takes the finger-sized variant of it.
 */
export const LARGE_TOUCH_LAYOUT_QUERY =
  `(pointer: coarse) and (hover: none) and (min-width: 768px) and (min-height: ${LARGE_TOUCH_MIN_SHORT_SIDE}px)`;

export interface FormFactorSignals {
  /** `(pointer: coarse) and (hover: none)`: the query isMobileDevice.ts owns. */
  readonly touchFirst: boolean;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/** Pure rule (the testable core). */
export function classifyFormFactor(s: FormFactorSignals): RuntimeFormFactor {
  if (!s.touchFirst) return 'desktop';
  return Math.min(s.viewportWidth, s.viewportHeight) >= LARGE_TOUCH_MIN_SHORT_SIDE ? 'large-touch' : 'phone';
}

/** Read the signals from the running browser. */
export function currentFormFactorSignals(): FormFactorSignals {
  const w = typeof window === 'undefined' ? 0 : window.innerWidth;
  const h = typeof window === 'undefined' ? 0 : window.innerHeight;
  return { touchFirst: isTouchFirstDevice(), viewportWidth: w, viewportHeight: h };
}

export function runtimeFormFactor(): RuntimeFormFactor {
  return classifyFormFactor(currentFormFactorSignals());
}
