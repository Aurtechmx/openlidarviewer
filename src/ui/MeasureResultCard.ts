/**
 * MeasureResultCard.ts: the compact readout of the latest completed
 * measurement, kept next to the viewport so the result is beside the action.
 *
 * One instance. Its buttons are built once and wired once; `show` only changes
 * their text and visibility, so showing a second result never stacks a second
 * set of listeners. The value line is a polite live region, so the figure is
 * announced when it appears. It formats nothing: the model carries the text.
 */

import { el } from './dom';
import type { ResultModel } from '../app/measureResultModel';

export interface MeasureResultCardHandlers {
  onCopy: (model: ResultModel) => void;
  onOpenDetails: (id: string) => void;
  onUseAsClip: (id: string) => void;
  onDismiss: () => void;
}

export class MeasureResultCard {
  readonly element: HTMLElement;
  private readonly _label: HTMLElement;
  private readonly _value: HTMLElement;
  private readonly _caveat: HTMLElement;
  private readonly _copy: HTMLButtonElement;
  private readonly _open: HTMLButtonElement;
  private readonly _clip: HTMLButtonElement;
  private _model: ResultModel | null = null;
  private _clipLabel = 'Use as clipping region';

  constructor(handlers: MeasureResultCardHandlers) {
    this._label = el('span', { className: 'olv-result-label' });
    this._value = el('span', { className: 'olv-result-value' });
    this._value.setAttribute('role', 'status');
    this._value.setAttribute('aria-live', 'polite');
    this._caveat = el('span', { className: 'olv-result-caveat olv-hidden' });
    const dismiss = el('button', {
      className: 'olv-result-dismiss', type: 'button', text: '×',
      title: 'Dismiss this result', ariaLabel: 'Dismiss result',
    });
    this._copy = el('button', { className: 'olv-result-btn', type: 'button', text: 'Copy result', title: 'Copy this result, with its caveat, to the clipboard' });
    this._open = el('button', { className: 'olv-result-btn', type: 'button', text: 'Open details', title: 'Show this measurement in the Measure page' });
    this._clip = el('button', { className: 'olv-result-btn olv-result-clip olv-hidden', type: 'button', text: this._clipLabel, title: 'Clip the scan to this box. The measurement is left as drawn.' });

    this._copy.addEventListener('click', () => { if (this._model) handlers.onCopy(this._model); });
    this._open.addEventListener('click', () => { if (this._model) handlers.onOpenDetails(this._model.id); });
    this._clip.addEventListener('click', () => { if (this._model) handlers.onUseAsClip(this._model.id); });
    dismiss.addEventListener('click', () => handlers.onDismiss());

    this.element = el('section', { className: 'olv-result-card olv-hidden' }, [
      el('div', { className: 'olv-result-head' }, [this._label, dismiss]),
      this._value,
      this._caveat,
      el('div', { className: 'olv-result-actions' }, [this._copy, this._open, this._clip]),
    ]);
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Latest measurement result');
  }

  /** The measurement the card is showing, or null when hidden. */
  get shownId(): string | null {
    return this._model ? this._model.id : null;
  }

  /**
   * Show or refresh the card. `clipLabel` names the clip action for this
   * result ("Isolate this box" after Draw clipping box, else the row's wording).
   */
  show(model: ResultModel, clipLabel = 'Use as clipping region'): void {
    this._model = model;
    this._clipLabel = clipLabel;
    this._label.textContent = model.name;
    this._value.textContent = model.value;
    this._value.classList.toggle('is-missing', model.status === 'no-value');
    this._value.classList.toggle('is-withheld', model.status === 'not-presentable');
    this._caveat.textContent = model.caveat ?? '';
    this._caveat.classList.toggle('olv-hidden', model.caveat === null);
    this._copy.disabled = model.copyText === null;
    this._clip.textContent = clipLabel;
    this._clip.classList.toggle('olv-hidden', !model.canClip);
    this._clip.setAttribute('aria-label', `${clipLabel}: ${model.name}`);
    this.element.classList.remove('olv-hidden');
  }

  hide(): void {
    this._model = null;
    this.element.classList.add('olv-hidden');
  }
}
