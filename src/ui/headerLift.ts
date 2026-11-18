/**
 * headerLift.ts — keep the header raised while any of its popovers is open.
 *
 * `.olv-topbar` carries its own z-index, which makes it a stacking context: a
 * popover opened from inside it cannot paint above the rails however high its
 * own z-index reads. The header is lifted with one class while a popover is
 * open (20-topbar.css). About and the Performance panel share that class, so
 * each reports its own state here and the class stays while either is open:
 * closing one must not drop the other under the rails.
 */

/** The class 20-topbar.css lifts the header with. */
export const HEADER_LIFT_CLASS = 'olv-topbar-popover-open';

/**
 * Each open popover and the header it lifted. The header is remembered on open,
 * so a popover that closes after leaving the page still releases it.
 */
const openPopovers = new Map<Element, Element>();

/** Record that `popover` opened or closed, and lift its header while any of its popovers is open. */
export function setHeaderPopoverOpen(popover: Element, isOpen: boolean): void {
  const header = openPopovers.get(popover) ?? popover.closest('.olv-topbar');
  if (!header) return;
  if (isOpen) openPopovers.set(popover, header);
  else openPopovers.delete(popover);
  let lifted = false;
  for (const h of openPopovers.values()) if (h === header) lifted = true;
  header.classList.toggle(HEADER_LIFT_CLASS, lifted);
}
