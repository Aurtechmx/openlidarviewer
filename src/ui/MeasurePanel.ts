/**
 * MeasurePanel.ts
 *
 * The Measurements panel — a compact list of every placed measurement plus a
 * footer to export / import a measurement session (measurements and saved
 * camera views together, as one JSON file). A dumb view: the controller
 * computes the summaries; the panel renders them and reports intents back.
 */

import { el } from './dom';
import type { MeasurementSummary } from '../render/measure/MeasureController';

/** Hooks the panel calls back into. */
export interface MeasurePanelCallbacks {
  /** Delete the measurement with this id. */
  onDelete: (id: string) => void;
  /** Rename the measurement with this id. */
  onRename: (id: string, name: string) => void;
  /** Export the current session to a JSON file. */
  onExport: () => void;
  /** Import a session from a picked JSON file. */
  onImport: (file: File) => void;
}

export class MeasurePanel {
  /** The panel element — append to the stage overlay. */
  readonly element: HTMLElement;
  private readonly _cb: MeasurePanelCallbacks;
  private readonly _list: HTMLElement;

  constructor(callbacks: MeasurePanelCallbacks) {
    this._cb = callbacks;
    this._list = el('div', { className: 'olv-mp-list' });

    // Export / import a measurement session.
    const fileInput = el('input', { className: 'olv-file-input', type: 'file' });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this._cb.onImport(file);
      fileInput.value = ''; // let the same file be re-picked
    });
    const exportBtn = el('button', {
      className: 'olv-mp-action',
      text: 'Export',
      title: 'Save all measurements and saved views to a JSON session file',
    });
    exportBtn.addEventListener('click', () => {
      exportBtn.blur();
      this._cb.onExport();
    });
    const importBtn = el('button', {
      className: 'olv-mp-action',
      text: 'Import',
      title: 'Load measurements and saved views from a JSON session file',
    });
    importBtn.addEventListener('click', () => {
      importBtn.blur();
      fileInput.click();
    });

    this.element = el('aside', { className: 'olv-measure-panel olv-hidden' }, [
      el('div', { className: 'olv-mp-title', text: 'Measurements' }),
      this._list,
      el('div', { className: 'olv-mp-footer' }, [exportBtn, importBtn, fileInput]),
    ]);
  }

  /** Show or hide the panel. */
  setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
  }

  /** Rebuild the measurement list from the controller's summaries. */
  update(summaries: MeasurementSummary[]): void {
    if (summaries.length === 0) {
      this._list.replaceChildren(
        el('div', { className: 'olv-mp-empty', text: 'No measurements yet.' }),
      );
      return;
    }
    this._list.replaceChildren(...summaries.map((s) => this._row(s)));
  }

  private _row(s: MeasurementSummary): HTMLElement {
    const dot = el('span', { className: 'olv-mp-kind', title: s.kind });

    const name = el('input', {
      className: 'olv-mp-name',
      title: 'Type to rename this measurement',
    });
    name.value = s.name;
    name.addEventListener('change', () => this._cb.onRename(s.id, name.value));

    const value = el('span', { className: 'olv-mp-value', text: s.value });

    const del = el('button', {
      className: 'olv-mp-del',
      text: '×',
      title: `Delete ${s.name}`,
      ariaLabel: `Delete ${s.name}`,
    });
    del.addEventListener('click', () => this._cb.onDelete(s.id));

    return el('div', { className: 'olv-mp-row' }, [dot, name, value, del]);
  }
}
