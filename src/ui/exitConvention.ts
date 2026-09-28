/**
 * exitConvention.ts
 *
 * Shared pieces of the one exit convention (spec CE-1, section 4), applied by
 * the location bar so the surfaces they touch need no import of their own.
 *
 * - `closeTransients`: one transient surface at a time (CE-EXIT-04). Opening
 *   the command palette or a result focus first closes any open popover (the
 *   dock's More menu, the Performance settings) and any other result focus,
 *   through each one's own toggle or close control so its state and focus
 *   rules still apply.
 * - `labelModalBack`: a dialog that holds a surface (a lab, a result focus)
 *   leaves by a Back that names where it returns (CE-EXIT-01), read from the
 *   location bar, instead of a bare close glyph.
 */

/** Dialogs that hold a surface rather than ask a question. */
export const SURFACE_DIALOGS = '.olv-surface-dialog, .olv-result-focus';

/** Popover toggles that are open, found by their disclosure state. */
const OPEN_POPOVERS = '.olv-tool-more[aria-expanded="true"], [aria-haspopup][aria-expanded="true"]';

/** Close every open popover and result focus, except inside `keep`. */
export function closeTransients(keep: Element | null = null, doc: Document = document): void {
  const hits = doc.querySelectorAll?.<HTMLElement>(`${OPEN_POPOVERS}, .olv-result-focus:not(.olv-modal-closing) .olv-modal-x`);
  hits?.forEach((b) => {
    if (!keep?.contains(b)) b.click();
  });
}

/** Where closing a dialog returns: the location bar's current place, or the scan. */
export function backDestination(doc: Document = document): string {
  return doc.querySelector?.<HTMLElement>('.olv-loc[data-here]')?.dataset.here || 'scan';
}

/**
 * Turn a dialog's close glyph into a Back that names its destination. The
 * control keeps its class and its click, so Escape, focus restore and every
 * existing hook behave as before.
 */
export function labelModalBack(root: HTMLElement | null | undefined, doc: Document = document): void {
  const x = root?.querySelector?.<HTMLElement>('.olv-modal-x');
  if (!x) return;
  const to = backDestination(doc);
  x.textContent = `← ${to}`;
  x.setAttribute('aria-label', `Back to ${to}`);
  x.setAttribute('data-tip', `Close this and go back to ${to}.`);
  x.removeAttribute?.('aria-describedby');
  x.classList.add('olv-modal-back');
}
