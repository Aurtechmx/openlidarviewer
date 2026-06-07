/**
 * Modal.ts
 *
 * A small, reusable accessible modal — a dimmed backdrop holding a centred
 * dialog card in the dark "instrument" aesthetic. Built for the pre-export MAP
 * PDF dialog but deliberately content-agnostic so other flows can reuse it.
 *
 * Accessibility: the dialog carries `role="dialog"` + `aria-modal="true"` and
 * is labelled by its title. Focus is trapped inside the dialog (Tab / Shift+Tab
 * cycle the focusable children), Escape closes it, a click on the backdrop
 * (outside the card) closes it, and focus is restored to the trigger (or the
 * previously-focused element) when it closes.
 *
 * Browser-bound (DOM) — not imported in Node tests.
 */

import { el } from './dom';

export interface ModalOptions {
  /** Visible dialog title; also wires `aria-labelledby`. */
  readonly title: string;
  /** The dialog body (form fields, etc.). */
  readonly body: HTMLElement;
  /** The action row (e.g. Export / Cancel). Pinned below the scrollable body. */
  readonly footer?: HTMLElement;
  /** Element to restore focus to on close; defaults to the active element at open. */
  readonly returnFocusTo?: HTMLElement | null;
  /** Called once, after the modal is torn down. */
  readonly onClose?: () => void;
}

export interface ModalHandle {
  /** The backdrop element (already mounted into the document). */
  readonly element: HTMLElement;
  /** Close the modal, restore focus, and fire `onClose` (idempotent). */
  close(): void;
}

/** Selector for the elements Tab should cycle through inside the dialog. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

let modalSeq = 0;

/**
 * Open an accessible modal and mount it on `document.body`. Returns a handle
 * whose `close()` tears it down and restores focus. The caller owns the
 * body/footer content; this primitive only provides the chrome + a11y wiring.
 */
export function openModal(opts: ModalOptions): ModalHandle {
  const restoreTo =
    opts.returnFocusTo ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  const titleId = `olv-modal-title-${++modalSeq}`;
  const titleEl = el('h2', { className: 'olv-modal-title', text: opts.title });
  titleEl.id = titleId;

  const closeBtn = el('button', {
    className: 'olv-modal-x',
    text: '×', // ×
    ariaLabel: 'Close dialog',
    type: 'button',
  });

  const head = el('div', { className: 'olv-modal-head' }, [titleEl, closeBtn]);
  const bodyWrap = el('div', { className: 'olv-modal-body' }, [opts.body]);
  const children: HTMLElement[] = [head, bodyWrap];
  if (opts.footer) children.push(el('div', { className: 'olv-modal-foot' }, [opts.footer]));

  const dialog = el('div', { className: 'olv-modal' }, children);
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);

  const backdrop = el('div', { className: 'olv-modal-backdrop' }, [dialog]);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
    // Restore focus to the trigger so keyboard users land back where they were.
    if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    opts.onClose?.();
  };

  const focusable = (): HTMLElement[] =>
    Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (n) => n.offsetParent !== null || n === document.activeElement,
    );

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Focus trap — keep Tab / Shift+Tab cycling within the dialog.
    const items = focusable();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  closeBtn.addEventListener('click', () => close());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  window.addEventListener('keydown', onKeyDown, true);

  document.body.append(backdrop);

  // Move focus into the dialog: the first field, else the dialog itself.
  const initial = focusable()[0] ?? dialog;
  initial.focus();

  return { element: backdrop, close };
}
