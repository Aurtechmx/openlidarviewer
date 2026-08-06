/**
 * isMobileDevice.ts — one place to decide "is this a mobile device".
 *
 * Two questions kept deliberately separate:
 *   - MOBILE_LAYOUT_QUERY: the media condition the CSS `@media` LAYOUT rules
 *     also use. The layout swap keys off this so JS layout and CSS never
 *     disagree. It is orientation-independent: a phone stays in the mobile
 *     layout in BOTH portrait and landscape (see below) without turning the
 *     mobile layout on for a real desktop.
 *   - isMobileDevice(): INPUT-aware — a coarse pointer with no hover (phone or
 *     tablet) OR a narrow window. Drives BEHAVIOUR (memory / cellular warnings,
 *     the tighter point budget) where the actual input device matters more than
 *     the pixel width. A landscape phone wider than 767px is still a phone; a
 *     narrow desktop window with a mouse is not.
 */

/**
 * Numeric limits behind the mobile-layout media condition. Kept as constants so
 * the JS predicate and the constructed media string can never drift apart.
 */
export const MOBILE_MAX_WIDTH = 767;
/** A landscape phone is wide but short; 500px is below any tablet's short edge. */
export const MOBILE_LANDSCAPE_MAX_HEIGHT = 500;

/**
 * The media condition shared with the CSS `@media` LAYOUT rules. It fires for a
 * phone in EITHER orientation:
 *   - `(max-width: 767px)`: the classic narrow-viewport (portrait phone) case.
 *   - `(max-height: 500px) and (pointer: coarse)`: a landscape phone, where the
 *     viewport is now wider than 767px, but it is short AND driven by a coarse
 *     pointer. A real desktop is tall and/or fine-pointer, so it never matches;
 *     a narrow desktop window keeps today's width-only behaviour.
 * A comma is media-query OR, so matchMedia() evaluates the union.
 */
export const MOBILE_LAYOUT_QUERY =
  `(max-width: ${MOBILE_MAX_WIDTH}px), ` +
  `(max-height: ${MOBILE_LANDSCAPE_MAX_HEIGHT}px) and (pointer: coarse)`;

/**
 * Pure mirror of MOBILE_LAYOUT_QUERY, for tests and any non-matchMedia caller.
 * True when the viewport should use the mobile layout.
 */
export function matchesMobileLayout(vw: number, vh: number, coarse: boolean): boolean {
  return vw <= MOBILE_MAX_WIDTH || (vh <= MOBILE_LANDSCAPE_MAX_HEIGHT && coarse);
}

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
