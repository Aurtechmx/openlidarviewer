/**
 * politeAnnounce.ts — write to the application's single polite live region.
 *
 * The region is created and owned by DropZone, which mounts one `role="status"`
 * and one `role="alert"` node on the drop target rather than inside the toast,
 * because the toast toggles with `display: none` and a hidden element is out of
 * the accessibility tree, so a live region inside it announces nothing.
 * `tests/e2e/a11yAnnouncements.spec.ts` asserts there is exactly one of each.
 *
 * Anything else that needs to announce has to reach that node rather than mint
 * its own. Two polite regions give a screen reader two competing queues, and
 * announcements from them interleave unpredictably.
 *
 * A DOM lookup rather than an injected reference, because the alternative is
 * threading a DropZone through Stage from `src/main.ts`, and main.ts sits under
 * a ratchet that refuses an added line. The selector is not incidental coupling:
 * the end-to-end suite already asserts it, so it is the contract both sides are
 * held to.
 */

/** The selector the accessibility suite pins. */
export const POLITE_REGION_SELECTOR = '.olv-visually-hidden[role="status"]';

/**
 * Announce `message` politely, returning whether a region was found.
 *
 * The text is cleared before it is set. A screen reader announces a change, and
 * assigning byte-identical text is not one, so a second identical message would
 * otherwise be silent. That matters here: a refused request repeated is exactly
 * the case a user needs told twice.
 */
export function announcePolite(message: string, doc: Document = document): boolean {
  const region = doc.querySelector(POLITE_REGION_SELECTOR);
  if (!region) return false;
  region.textContent = '';
  region.textContent = message;
  return true;
}
