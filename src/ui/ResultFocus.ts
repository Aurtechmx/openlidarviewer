/**
 * ResultFocus.ts
 *
 * A shared "expand to focus" surface. A rich result that has outgrown its dock
 * — a profile chart with a stats block and a long station table — can escalate
 * into a large floating panel over a dimmed, blurred backdrop that isolates it
 * from the point cloud, then collapse back to where it came from.
 *
 * This is a presentation container, nothing more: the caller renders the SAME
 * data/chart nodes it already builds in-panel into the supplied element. The
 * primitive owns only the chrome, the enter/exit motion, and the a11y wiring —
 * all of which it inherits from `openModal` (focus trap, Escape, backdrop-click,
 * focus restore, role/aria-modal). Any panel can adopt it via `openResultFocus`.
 *
 * Browser-bound (DOM) — the motion + trigger geometry read the live layout.
 */

import { el } from './dom';
import { openModal, type ModalHandle } from './Modal';

export interface ResultFocusOptions {
  /** Surface title — labels the dialog for assistive tech. */
  readonly title: string;
  /** Fill the surface body. Called once, synchronously, before the open. */
  readonly render: (container: HTMLElement) => void;
  /**
   * The control that opened the surface. The scale-in grows from it and focus
   * returns to it on close, so the escalation reads as an extension of that
   * button rather than an unrelated pop-up.
   */
  readonly triggerEl?: HTMLElement | null;
}

export type ResultFocusHandle = ModalHandle;

/**
 * Exit duration, in ms — kept in step with the `.olv-modal-closing` transition
 * in style.css so the surface is removed exactly as its fade finishes. The
 * enter animation is CSS-driven (`.olv-result-focus .olv-modal`); only the exit
 * needs a JS timer because the DOM node is torn down at the end of it.
 */
const EXIT_MS = 130;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Open a focus surface and mount it on `document.body`. Returns the `openModal`
 * handle whose `close()` fades it out and restores focus to the trigger.
 */
export function openResultFocus(opts: ResultFocusOptions): ResultFocusHandle {
  const body = el('div', { className: 'olv-result-focus-body' });
  opts.render(body);

  // Reduced motion drops BOTH ends of the animation: the CSS media query kills
  // the scale-in, and a zero exit removes the surface immediately (no fade).
  const reduce = prefersReducedMotion();
  const handle = openModal({
    title: opts.title,
    body,
    returnFocusTo: opts.triggerEl ?? null,
    exitMs: reduce ? 0 : EXIT_MS,
  });

  const backdrop = handle.element;
  backdrop.classList.add('olv-result-focus');

  // Grow from the trigger: aim the dialog's transform-origin at the button that
  // opened it so the scale-in reads as that control expanding, not a new window
  // arriving from nowhere. Skipped under reduced motion (nothing scales).
  if (!reduce) {
    const dialog = backdrop.querySelector<HTMLElement>('.olv-modal');
    const trigger = opts.triggerEl;
    if (dialog && trigger && typeof trigger.getBoundingClientRect === 'function') {
      const t = trigger.getBoundingClientRect();
      const d = dialog.getBoundingClientRect();
      const ox = t.left + t.width / 2 - d.left;
      const oy = t.top + t.height / 2 - d.top;
      if (Number.isFinite(ox) && Number.isFinite(oy)) {
        dialog.style.transformOrigin = `${Math.round(ox)}px ${Math.round(oy)}px`;
      }
    }
  }

  return handle;
}
