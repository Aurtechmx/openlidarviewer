/**
 * EmptyViewNotice.ts: the card shown when the clip and the filters hide every
 * loaded point of the visible scans.
 *
 * It names what is on and offers the fixes that apply: Turn off clip while a
 * clip is on, Reset filters while a class, elevation or intensity filter is on.
 * Each button runs the control's own path (the clip panel's Turn off, the class
 * legend's Show all, the Inspector filters' Show all), so the panels stay in
 * step. Hidden scans are left to the Layers list, and a stream is not counted:
 * the host passes null for both and the card stays hidden.
 */

import { el } from './dom';

/** What is on while nothing is drawn. */
export interface EmptyViewCauses {
  readonly clip: boolean;
  readonly classes: boolean;
  readonly elevation: boolean;
  readonly intensity: boolean;
}

export interface EmptyViewActions {
  turnOffClip(): void;
  resetFilters(): void;
}

/** The card's sentence, or null when nothing on could explain an empty view. */
export function emptyViewText(c: EmptyViewCauses): string | null {
  const on = [
    c.clip && 'the clip box',
    c.classes && 'the class filter',
    c.elevation && 'the elevation filter',
    c.intensity && 'the intensity filter',
  ].filter((s): s is string => typeof s === 'string');
  if (on.length === 0) return null;
  if (on.length === 1) return `No points are drawn: ${on[0]} hides every loaded point of the visible scans.`;
  const list = `${on.slice(0, -1).join(', ')} and ${on[on.length - 1]}`;
  return `No points are drawn: between them, ${list} hide every loaded point of the visible scans.`;
}

export class EmptyViewNotice {
  readonly element: HTMLElement;
  private readonly _text: HTMLElement;
  private readonly _clipBtn: HTMLButtonElement;
  private readonly _filtersBtn: HTMLButtonElement;

  constructor(actions: EmptyViewActions) {
    this._text = el('p', { className: 'olv-empty-view-text' });
    this._clipBtn = el('button', {
      className: 'olv-result-btn', type: 'button', text: 'Turn off clip',
      title: 'Turn the clip off and show the whole scan',
    }) as HTMLButtonElement;
    this._clipBtn.addEventListener('click', () => actions.turnOffClip());
    this._filtersBtn = el('button', {
      className: 'olv-result-btn', type: 'button', text: 'Reset filters',
      title: 'Show every class and clear the elevation and intensity filters',
    }) as HTMLButtonElement;
    this._filtersBtn.addEventListener('click', () => actions.resetFilters());
    this.element = el('div', { className: 'olv-empty-view olv-hidden' }, [
      this._text,
      el('div', { className: 'olv-result-actions' }, [this._clipBtn, this._filtersBtn]),
    ]);
    this.element.setAttribute('role', 'status');
  }

  /** Show the card for these causes, or hide it with null. Cheap and idempotent. */
  sync(causes: EmptyViewCauses | null): void {
    const text = causes ? emptyViewText(causes) : null;
    this.element.classList.toggle('olv-hidden', text === null);
    if (text === null || !causes) return;
    if (this._text.textContent !== text) this._text.textContent = text;
    this._clipBtn.classList.toggle('olv-hidden', !causes.clip);
    this._filtersBtn.classList.toggle('olv-hidden', !(causes.classes || causes.elevation || causes.intensity));
  }

  /** Whether the card is showing. */
  get shown(): boolean {
    return !this.element.classList.contains('olv-hidden');
  }
}
