/**
 * HelpOverlay.ts
 *
 * A compact, static help overlay (should-have #15): a centred card over a
 * dimmed backdrop, summarising the inspection and measurement workflows, the
 * navigation controls, and the keyboard shortcuts.
 *
 * Static content — no live state, one close button. It is opened from the tool
 * dock's Help button (the `?` key belongs to the ShortcutSheet), and closed by
 * the button, a backdrop click, or Escape. Browser-bound (DOM); not imported
 * in Node tests.
 */

import { el } from './dom';

/** One labelled row inside a help section — a key/term and its description. */
type HelpRow = [term: string, description: string];

/** Build a section: a sub-heading followed by term/description rows. */
function section(heading: string, rows: HelpRow[]): HTMLElement {
  const body = el(
    'div',
    { className: 'olv-help-rows' },
    rows.map(([term, description]) =>
      el('div', { className: 'olv-help-row' }, [
        el('span', { className: 'olv-help-term', text: term }),
        el('span', { className: 'olv-help-desc', text: description }),
      ]),
    ),
  );
  return el('section', { className: 'olv-help-section' }, [
    el('h3', { className: 'olv-help-heading', text: heading }),
    body,
  ]);
}

export class HelpOverlay {
  /** The backdrop element (contains the card) — mount into the stage overlay. */
  readonly element: HTMLElement;

  private _open = false;
  private readonly _onKeyDown: (e: KeyboardEvent) => void;

  constructor() {
    const closeBtn = el('button', {
      className: 'olv-help-close',
      text: 'Close',
      ariaLabel: 'Close help',
    });
    closeBtn.addEventListener('click', () => {
      closeBtn.blur();
      this.close();
    });

    const card = el('div', { className: 'olv-help-card' }, [
      el('div', { className: 'olv-help-head' }, [
        el('span', { className: 'olv-help-title', text: 'OpenLiDARViewer — Help' }),
        closeBtn,
      ]),
      el('div', { className: 'olv-help-body' }, [
        section('Tools', [
          ['Measure', 'Distances, areas, heights, angles and slope on the scan.'],
          ['Inspect', 'Click any point to read its coordinates and attributes.'],
          ['Probe', 'Hover the scan for a live point readout, with no click.'],
          ['Annotate', 'Mark a point of interest with a titled, categorised note.'],
        ]),
        section('Annotating', [
          ['Place', 'With Annotate on, click a point, fill the card, then Save.'],
          ['Camera', 'Keep "Save current camera view" to return to the exact framing.'],
          ['Revisit', 'The Annotations panel jumps to, edits or deletes any finding.'],
        ]),
        section('Navigation', [
          ['Orbit / Walk / Fly', 'Switch mode with 1, 2 and 3.'],
          ['Look', 'Drag to rotate, or orbit with the arrow keys; scroll to zoom.'],
          ['Move', 'WASD in walk and fly; Space / C raise and lower; hold Shift to sprint.'],
          ['Frame', 'R frames the whole scan; F focuses the centre; double-click a point to focus there.'],
        ]),
        section('Keyboard shortcuts', [
          ['A', 'Toggle the Annotate tool.'],
          ['M', 'Toggle the Measure tool.'],
          ['I', 'Toggle the Inspect tool.'],
          ['L', 'Toggle the lasso volume tool.'],
          ['T / O / P', 'Camera presets — Top, Oblique and Planar views.'],
          ['H', 'Show or hide the controls HUD.'],
          ['V', 'Save the current camera view.'],
          ['Delete', 'Remove the selected annotation.'],
          ['Enter / Backspace', 'While measuring: finish a shape / undo the last point.'],
          ['Ctrl+Z', 'Undo your last edit — annotation or classification; add Shift to redo.'],
          ['Cmd/Ctrl+K', 'Open the command palette.'],
          ['Esc', 'Cancel the active tool or draft.'],
          // `?` is owned by the ShortcutSheet (main.ts binds it before the
          // tool shortcuts and consumes the keystroke) — describe that
          // truthfully rather than claiming it toggles this overlay.
          ['?', 'Open the keyboard shortcut sheet.'],
        ]),
        section('Saving your work', [
          ['Snapshot', 'Exports a PNG with placed measurements and annotations.'],
          ['Session', 'Export or import the whole inspection as a JSON file.'],
          ['Local', 'Every scan stays on your device — nothing is uploaded.'],
        ]),
      ]),
    ]);
    // A click on the backdrop (outside the card) closes the overlay.
    this.element = el('div', { className: 'olv-help-backdrop olv-hidden' }, [card]);
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.close();
    });

    // Escape closes the overlay while it is open; the listener is only live
    // then, so it never competes with the tool-cancel Escape handling.
    this._onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    };
  }

  /** Whether the overlay is currently shown. */
  get isOpen(): boolean {
    return this._open;
  }

  /** Show the overlay. */
  open(): void {
    if (this._open) return;
    this._open = true;
    this.element.classList.remove('olv-hidden');
    window.addEventListener('keydown', this._onKeyDown, true);
  }

  /** Hide the overlay. */
  close(): void {
    if (!this._open) return;
    this._open = false;
    this.element.classList.add('olv-hidden');
    window.removeEventListener('keydown', this._onKeyDown, true);
  }

  /** Toggle the overlay open or closed. */
  toggle(): void {
    if (this._open) this.close();
    else this.open();
  }

  /** Free DOM references and any live listener. */
  dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown, true);
    this.element.remove();
  }
}
