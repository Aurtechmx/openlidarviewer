/**
 * isMobileDevice.ts — one place to decide "is this a mobile device".
 *
 * Two questions kept deliberately separate:
 *   - MOBILE_LAYOUT_QUERY: the WIDTH breakpoint the CSS `@media` rules also use.
 *     The layout swap keys off this so JS layout and CSS never disagree.
 *   - isMobileDevice(): INPUT-aware — a coarse pointer with no hover (phone or
 *     tablet) OR a narrow window. Drives BEHAVIOUR (memory / cellular warnings,
 *     the tighter point budget) where the actual input device matters more than
 *     the pixel width. A landscape phone wider than 767px is still a phone; a
 *     narrow desktop window with a mouse is not.
 */

/** The width breakpoint shared with the CSS `@media` rules. */
export const MOBILE_LAYOUT_QUERY = '(max-width: 767px)';

/** Pure classifier (the testable core). Mobile = narrow OR touch-first. */
export function classifyMobile(narrow: boolean, coarseNoHover: boolean): boolean {
  return narrow || coarseNoHover;
}

/** Input-aware "is this a mobile device", for behaviour (not CSS layout). */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return classifyMobile(
    window.matchMedia(MOBILE_LAYOUT_QUERY).matches,
    window.matchMedia('(pointer: coarse) and (hover: none)').matches,
  );
}
