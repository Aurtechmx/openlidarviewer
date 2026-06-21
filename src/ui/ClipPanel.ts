/**
 * ClipPanel.ts — the clip-box control.
 *
 * A compact left panel that drives the viewer's axis-aligned clip box: enable,
 * keep-inside vs keep-outside, six numeric extents, a "Fit to scan" that seeds
 * the box from the active cloud's bounds, and a live "kept of total" readout.
 *
 * The keep/cull decision and the count are the pure `clipBox` core; this panel
 * is only the DOM around it. The in-viewport GPU result is browser-verified.
 */

import { el } from './dom';
import type { ClipBox, ClipMode } from '../render/clip/clipBox';
import type { BoxBounds } from '../render/measure/geometry';

export interface ClipPanelCallbacks {
  /** Apply the clip (or `null`/disabled to clear it) to the viewer. */
  onApply: (clip: ClipBox | null) => void;
  /** The active cloud's bounds, to seed the box from "Fit to scan". */
  fitBounds: () => BoxBounds | null;
  /** Exact kept/total count for a clip against the active cloud (CPU). */
  keptCount: (clip: ClipBox) => { kept: number; total: number } | null;
}

type Axis = 0 | 1 | 2;
const AXES: ReadonlyArray<{ axis: Axis; label: string }> = [
  { axis: 0, label: 'X' },
  { axis: 1, label: 'Y' },
  { axis: 2, label: 'Z' },
];

export class ClipPanel {
  readonly element: HTMLElement;
  private readonly _cb: ClipPanelCallbacks;
  private _enabled = false;
  private _mode: ClipMode = 'keep-inside';
  private _min: [number, number, number] = [0, 0, 0];
  private _max: [number, number, number] = [1, 1, 1];
  private readonly _minInputs: HTMLInputElement[] = [];
  private readonly _maxInputs: HTMLInputElement[] = [];
  private readonly _enableBox: HTMLInputElement;
  private readonly _modeBtns = new Map<ClipMode, HTMLButtonElement>();
  private readonly _readout: HTMLElement;

  constructor(callbacks: ClipPanelCallbacks) {
    this._cb = callbacks;
    this.element = el('section', { className: 'olv-clip-panel' });

    const title = el('div', { className: 'olv-panel-title', text: 'Clip box' });
    const chevron = el('span', { className: 'olv-chevron', text: '▾' });
    const collapseBtn = el('button', { className: 'olv-collapse-toggle', title: 'Collapse this panel' });
    collapseBtn.setAttribute('type', 'button');
    collapseBtn.setAttribute('aria-label', 'Collapse Clip panel');
    collapseBtn.append(chevron);
    const head = el('div', { className: 'olv-panel-head' });
    head.append(title, collapseBtn);
    const toggle = (): void => { this.element.classList.toggle('olv-collapsed'); };
    collapseBtn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    head.addEventListener('click', (e) => { if (e.target === head || title.contains(e.target as Node)) toggle(); });

    // Enable
    this._enableBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
    this._enableBox.addEventListener('change', () => {
      this._enabled = this._enableBox.checked;
      this._apply();
    });
    const enableLabel = el('label', { className: 'olv-clip-enable' });
    enableLabel.append(this._enableBox, el('span', { text: 'Clip the scan to this box' }));

    // Mode
    const modeRow = el('div', { className: 'olv-bc-pills' });
    ([['keep-inside', 'Inside'], ['keep-outside', 'Outside']] as const).forEach(([mode, label]) => {
      const btn = el('button', {
        className: `olv-bc-pill${this._mode === mode ? ' is-active' : ''}`,
        type: 'button',
        text: label,
        title: mode === 'keep-inside' ? 'Show only points inside the box' : 'Hide points inside the box',
      }) as HTMLButtonElement;
      btn.addEventListener('click', () => this._setMode(mode));
      this._modeBtns.set(mode, btn);
      modeRow.append(btn);
    });

    // Extents grid
    const grid = el('div', { className: 'olv-clip-grid' });
    for (const { axis, label } of AXES) {
      const mn = this._numInput((v) => { this._min[axis] = v; this._apply(); });
      const mx = this._numInput((v) => { this._max[axis] = v; this._apply(); });
      this._minInputs[axis] = mn;
      this._maxInputs[axis] = mx;
      grid.append(
        el('span', { className: 'olv-clip-axis', text: label }),
        mn,
        mx,
      );
    }

    const fit = el('button', { className: 'olv-bc-pill', type: 'button', text: 'Fit to scan' }) as HTMLButtonElement;
    fit.addEventListener('click', () => this._fit());

    this._readout = el('p', { className: 'olv-export-fullres-hint', text: '' });

    const body = el('div', { className: 'olv-clip-body' }, [
      enableLabel,
      el('div', { className: 'olv-bc-section-label', text: 'Mode' }),
      modeRow,
      el('div', { className: 'olv-clip-grid-head' }, [
        el('span', { text: '' }), el('span', { text: 'min' }), el('span', { text: 'max' }),
      ]),
      grid,
      fit,
      this._readout,
    ]);

    this.element.append(head, body);
    this.element.classList.add('olv-collapsed');
    this.setVisible(false);
  }

  setVisible(on: boolean): void {
    this.element.style.display = on ? '' : 'none';
    if (!on) {
      // Hiding the panel (scan closed) clears the clip so it can't persist.
      this._enabled = false;
      this._enableBox.checked = false;
      this._cb.onApply(null);
    }
  }

  /** Seed the box from the active cloud's bounds (also called on first reveal). */
  fitToScan(): void {
    this._fit();
  }

  private _numInput(onChange: (v: number) => void): HTMLInputElement {
    const input = el('input', { className: 'olv-bc-input olv-clip-num', type: 'number' }) as HTMLInputElement;
    input.step = 'any';
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) onChange(v);
    });
    return input;
  }

  private _setMode(mode: ClipMode): void {
    this._mode = mode;
    for (const [m, btn] of this._modeBtns) btn.classList.toggle('is-active', m === mode);
    this._apply();
  }

  private _fit(): void {
    const b = this._cb.fitBounds();
    if (!b) return;
    this._min = [b.min[0], b.min[1], b.min[2]];
    this._max = [b.max[0], b.max[1], b.max[2]];
    for (const { axis } of AXES) {
      this._minInputs[axis].value = String(round(this._min[axis]));
      this._maxInputs[axis].value = String(round(this._max[axis]));
    }
    this._apply();
  }

  private _current(): ClipBox {
    return { box: { min: [...this._min], max: [...this._max] }, mode: this._mode, enabled: this._enabled };
  }

  private _apply(): void {
    const clip = this._current();
    this._cb.onApply(this._enabled ? clip : null);
    if (this._enabled) {
      const c = this._cb.keptCount(clip);
      this._readout.textContent = c
        ? `${c.kept.toLocaleString()} of ${c.total.toLocaleString()} points kept.`
        : '';
    } else {
      this._readout.textContent = 'Enable to clip the scan to the box above.';
    }
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
