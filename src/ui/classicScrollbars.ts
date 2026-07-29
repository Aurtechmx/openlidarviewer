/**
 * classicScrollbars.ts
 *
 * Detect whether this platform draws scrollbars that occupy layout width.
 *
 * Windows and most Linux desktops draw a classic scrollbar: always visible,
 * ~15px of reserved width, and dragged with the pointer. macOS and iOS draw an
 * overlay scrollbar: zero width, hidden until it scrolls, never dragged.
 *
 * That difference is the root of a family of defects. A rule that is inert
 * under overlay scrollbars is load-bearing under classic ones, so fixes for
 * the classic case can regress the overlay case if applied everywhere. The
 * mitigations are scoped to a class this sets, rather than shipped to both.
 *
 * Measured rather than sniffed. A user agent string does not say how the
 * platform draws its scrollbars, and the setting is user-changeable on Windows
 * and on macOS ("Show scroll bars: Always"). One probe answers it exactly.
 */

/** The class added to `<html>` when scrollbars take layout width. */
export const CLASSIC_SCROLLBAR_CLASS = 'olv-classic-scrollbars';

/**
 * Width in CSS pixels the platform reserves for a vertical scrollbar.
 * Zero means overlay scrollbars.
 */
export function measureScrollbarWidth(doc: Document = document): number {
  const probe = doc.createElement('div');
  // Off-screen rather than hidden: `display: none` has no layout to measure.
  probe.style.cssText =
    'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll';
  doc.body.appendChild(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

/**
 * Mark the document when scrollbars take layout width, and return whether they
 * do. Safe to call more than once.
 */
export function applyClassicScrollbarClass(doc: Document = document): boolean {
  const classic = measureScrollbarWidth(doc) > 0;
  doc.documentElement.classList.toggle(CLASSIC_SCROLLBAR_CLASS, classic);
  return classic;
}
