/**
 * scrollbarGutter.ts
 *
 * How wide the workspace rail's reserved scrollbar gutter actually is, as a
 * CSS custom property.
 *
 * `.olv-ws-body` scrolls with `scrollbar-gutter: stable`, so the space for a
 * scrollbar is reserved whether or not one is showing. How much space that is
 * depends on the platform rather than on this stylesheet: a classic scrollbar
 * takes the styled nine pixels permanently, and an overlay scrollbar takes
 * none. The panel card is laid out inside that content box either way.
 *
 * The rail's collapse handle is positioned against the rail's outer edge and
 * is meant to overlap the panel's hairline by a pixel, so the two read as one
 * surface. Where a gutter is reserved, the card stops short of that edge by
 * the gutter width and the handle detaches, which is a visible strip of scene
 * between a panel and its own control. Chrome shows it and a machine with
 * overlay scrollbars does not, which is why it survived review.
 *
 * The nine pixels are this application's own doing rather than the platform's.
 * `.olv-ws-body::-webkit-scrollbar` sets that width, so the gutter is reserved
 * even on a machine whose scrollbars overlay and would otherwise take none.
 * A detached probe element measures the PLATFORM default and reports zero
 * here, which is why the measurement is taken from the real scrolling element
 * and not from a scratch div. Firefox takes `scrollbar-width: thin` instead
 * and lands on its own number, which is the other reason not to hard-code one.
 *
 * Zero is the safe answer and the one an unmeasurable environment gets, since
 * it restores the geometry the stylesheet had before this existed.
 */

/** The property the rail stylesheet subtracts from the handle's offset. */
export const GUTTER_PROPERTY = '--olv-ws-gutter';

/**
 * The gutter an element reserves, as the difference between its border box and
 * its content box.
 *
 * Reads the element that actually scrolls. Under `scrollbar-gutter: stable`
 * this reports the reserved width whether or not the content currently
 * overflows, which is the case that matters: the panel is usually short enough
 * not to scroll and the gutter is held open anyway.
 */
export function measureGutterPx(scroller: HTMLElement): number {
  const width = scroller.offsetWidth - scroller.clientWidth;
  return Number.isFinite(width) && width > 0 ? width : 0;
}

/**
 * Publish the gutter the workspace body reserves.
 *
 * Measured from a probe that carries the real class, so the application's own
 * `.olv-ws-body::-webkit-scrollbar` width applies to it and Firefox's
 * `scrollbar-width: thin` applies as well. Reading the live rail instead would
 * have to wait for it: the host appends it, and it stays hidden until a scan
 * is open, so a hidden element reports no box for as long as the viewer has
 * opened nothing. The probe answers immediately and answers the same.
 *
 * It is attached, sized and removed within the call, so nothing outlives it
 * and there is no new resource for the disposal contract to own.
 *
 * Nothing it does can fail the caller. This is a cosmetic offset for a panel
 * handle, and a document that cannot be probed or written to, which is every
 * stub the workspace suites construct, gets the zero that restores the
 * geometry the stylesheet had before this existed.
 */
export function publishGutterWidth(doc: Document = document): number {
  let px = 0;
  try {
    const probe = doc.createElement('div');
    probe.className = 'olv-ws-body';
    probe.style.cssText =
      'position:absolute;top:-9999px;left:-9999px;width:120px;height:120px;'
      + 'overflow-y:scroll;visibility:hidden;';
    // Content taller than the box, so a scrollbar is genuinely warranted and
    // the reading does not depend on the gutter being reserved.
    const filler = doc.createElement('div');
    filler.style.cssText = 'height:400px;';
    probe.appendChild(filler);
    doc.body.appendChild(probe);
    px = measureGutterPx(probe);
    probe.remove();
  } catch {
    px = 0;
  }
  try {
    doc.documentElement.style.setProperty(GUTTER_PROPERTY, `${px}px`);
  } catch {
    return 0;
  }
  return px;
}
