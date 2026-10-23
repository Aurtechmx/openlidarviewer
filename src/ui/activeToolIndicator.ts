/**
 * activeToolIndicator.ts
 *
 * The small pill near the bottom of the viewport that says which pointer tool
 * owns the clicks: "Measuring distance", "Drawing box", "Adding annotation",
 * "Inspecting points". It shows nothing while the scene is only being orbited.
 *
 * The pill owns no tool state. It renders what {@link ActiveToolSnapshot}
 * says, and that snapshot is read from the controllers each time (see
 * `app/activeToolStatus.ts`). Its actions call back into the controller:
 * Finish appears only for a tool whose controller has a finish operation open
 * (a polyline or area draft), and Cancel runs the same exit Esc runs, so the
 * keyboard path and the button cannot disagree.
 *
 * Display state that persists after a tool is done (clipping on) is a separate
 * secondary chip, never written as an operation in progress.
 *
 * The step-by-step instruction stays in each tool's own hint bar; the pill
 * carries the mode and its actions, so no sentence is shown twice.
 *
 * Pure DOM via {@link el}; unit-testable against the live fake document.
 */

import { el } from './dom';

/** The pointer tool that owns the scene's clicks right now. */
export interface ActiveToolMode {
  /** Stable identity of the mode (tool plus kind), e.g. `measure:area`. */
  readonly key: string;
  /** What the pointer is doing, e.g. "Measuring area". */
  readonly label: string;
  /** Present only when the controller has an operation it can finish now. */
  readonly finish?: (() => void) | null;
  /** The controller's own exit: the same path Esc takes. */
  readonly cancel: () => void;
}

export interface ActiveToolSnapshot {
  readonly mode: ActiveToolMode | null;
  /** Persistent display state shown beside an active mode, e.g. "Clip on". */
  readonly chips: readonly string[];
}

export interface ActiveToolIndicator {
  readonly element: HTMLElement;
  /** Redraw from a snapshot. A null mode hides the pill. */
  update(snapshot: ActiveToolSnapshot): void;
  /** Hide the pill and forget the last mode (scan closed). */
  clear(): void;
  /** Detach the button listeners. */
  dispose(): void;
}

const IDLE: ActiveToolSnapshot = { mode: null, chips: [] };

export function createActiveToolIndicator(): ActiveToolIndicator {
  const label = el('span', { className: 'olv-ati-label' });
  const status = el('span', { className: 'olv-ati-status' }, [label]);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const chips = el('span', { className: 'olv-ati-chips' });
  const finish = el('button', { className: 'olv-ati-btn olv-ati-finish', type: 'button', text: 'Finish', tip: 'Finish the open measurement' }) as HTMLButtonElement;
  const cancel = el('button', { className: 'olv-ati-btn olv-ati-cancel', type: 'button', tip: 'Leave the tool and return to navigation (Esc)' }) as HTMLButtonElement;
  // The key cap is drawn from data-key by CSS, so it is not part of the
  // button's text: the visible label is "Cancel", which leads the accessible
  // name, and the shortcut is in that name and in aria-keyshortcuts.
  const key = el('kbd', { className: 'olv-ati-key' });
  key.dataset.key = 'Esc';
  key.setAttribute('aria-hidden', 'true');
  cancel.append(el('span', { text: 'Cancel' }), key);
  cancel.setAttribute('aria-keyshortcuts', 'Escape');
  const element = el('div', { className: 'olv-ati olv-hidden' }, [status, chips, finish, cancel]);
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Active tool');

  let current: ActiveToolSnapshot = IDLE;
  let lastChips = '';
  const onFinish = (): void => { current.mode?.finish?.(); };
  const onCancel = (): void => { current.mode?.cancel(); };
  finish.addEventListener('click', onFinish);
  cancel.addEventListener('click', onCancel);

  /**
   * Every write is conditional: the pill shares the overlay with observers
   * (the tools' bars, layout guards), and a write that changes nothing still
   * queues a mutation record, which could start a ping-pong.
   */
  const setAttr = (n: HTMLElement, k: string, v: string): void => { if (n.getAttribute(k) !== v) n.setAttribute(k, v); };
  const show = (n: HTMLElement, on: boolean): void => {
    if (n.hidden === on) n.hidden = !on;
    if (n.classList.contains('olv-hidden') === on) n.classList.toggle('olv-hidden', !on);
  };

  function update(next: ActiveToolSnapshot): void {
    current = next;
    const mode = next.mode;
    show(element, !!mode);
    // Write text only on a real change so the polite region announces once.
    const text = mode?.label ?? '';
    if (label.textContent !== text) label.textContent = text;
    if (mode && element.dataset.tool !== mode.key) element.dataset.tool = mode.key;
    else if (!mode && element.dataset.tool !== undefined) delete element.dataset.tool;
    show(finish, !!mode?.finish);
    if (mode) {
      setAttr(finish, 'aria-label', `Finish ${mode.label.toLowerCase()}`);
      setAttr(cancel, 'aria-label', `Cancel ${mode.label.toLowerCase()} (Esc)`);
    }
    const shown = mode ? next.chips : [];
    const key = shown.join('\u0000');
    if (key !== lastChips) {
      lastChips = key;
      chips.replaceChildren(...shown.map((c) => el('span', { className: 'olv-ati-chip', text: c })));
    }
    if (chips.hidden !== (shown.length === 0)) chips.hidden = shown.length === 0;
  }

  update(IDLE);
  return {
    element,
    update,
    clear: () => update(IDLE),
    dispose: () => {
      finish.removeEventListener('click', onFinish);
      cancel.removeEventListener('click', onCancel);
      update(IDLE);
    },
  };
}
