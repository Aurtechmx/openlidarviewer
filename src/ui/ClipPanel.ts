/**
 * ClipPanel.ts — the clip-box control.
 *
 * A compact left panel that drives the viewer's axis-aligned clip box. The
 * primary controls are Draw clipping box, Enable, keep-inside vs keep-outside,
 * Fit to scan and Clear, with a live "kept of total" readout; the six numeric
 * extents sit behind an Advanced disclosure (a native <details>, collapsed by
 * default, whose nodes are built once and never recreated).
 *
 * The keep/cull decision and the count are the pure `clipBox` core; this panel
 * is only the DOM around it. The in-viewport GPU result is browser-verified.
 */

import { el } from './dom';
import type { ClipBox, ClipMode } from '../render/clip/clipBox';
import type { BoxBounds } from '../render/measure/geometry';
import { setClipScope } from '../render/clip/clipScope';

export { fitBoundsInProject } from '../render/clip/fitBoundsInProject';

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
  /** Trailing timer for the kept-point count — see _scheduleCount. */
  private _countTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped on every bounds / mode / enable change, on {@link invalidateCount}
   * (scan, placement or resident data changed), on hide and on dispose. A
   * scheduled count captures the value it was queued under and drops its
   * result when the value has moved on, so a stale count never overwrites a
   * newer one.
   */
  private _countGen = 0;
  private readonly _minInputs: HTMLInputElement[] = [];
  private readonly _maxInputs: HTMLInputElement[] = [];
  private readonly _enableBox: HTMLInputElement;
  private readonly _modeBtns = new Map<ClipMode, HTMLButtonElement>();
  private readonly _readout: HTMLElement;
  /** Inline message for numeric edits that were not applied. */
  private readonly _error: HTMLElement;
  private readonly _fieldErrors = new Map<Axis, string>();
  private readonly _listeners = new Set<() => void>();
  private readonly _advanced: HTMLElement;
  private readonly _draw: HTMLButtonElement;
  private _onDrawBox: (() => void) | null = null;

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
      btn.setAttribute('aria-pressed', this._mode === mode ? 'true' : 'false');
      btn.addEventListener('click', () => this._setMode(mode));
      this._modeBtns.set(mode, btn);
      modeRow.append(btn);
    });

    // Extents grid
    const grid = el('div', { className: 'olv-clip-grid' });
    for (const { axis, label } of AXES) {
      const mn = this._numInput(axis);
      const mx = this._numInput(axis);
      this._minInputs[axis] = mn;
      this._maxInputs[axis] = mx;
      mn.setAttribute('aria-label', `${label} min`);
      mx.setAttribute('aria-label', `${label} max`);
      grid.append(
        el('span', { className: 'olv-clip-axis', text: label }),
        mn,
        mx,
      );
    }

    const fit = el('button', {
      className: 'olv-bc-pill', type: 'button', text: 'Fit to scan',
      title: 'Reset the box to the full extent of the open scan.',
    }) as HTMLButtonElement;
    fit.addEventListener('click', () => this._fit());
    const clear = el('button', {
      className: 'olv-bc-pill olv-clip-clear', type: 'button', text: 'Clear',
      title: 'Turn the clip off and show the whole scan. The bounds stay under Advanced.',
    }) as HTMLButtonElement;
    clear.addEventListener('click', () => this.clear());
    const actions = el('div', { className: 'olv-bc-pills olv-clip-actions' }, [fit, clear]);

    this._draw = el('button', {
      className: 'olv-bc-pill olv-clip-draw olv-hidden', type: 'button', text: 'Draw clipping box',
      title: 'Draw a box on the scan with the Box measurement tool, then isolate it.',
    }) as HTMLButtonElement;
    this._draw.addEventListener('click', () => this._onDrawBox?.());

    // Advanced: the six numeric extents. A native disclosure, closed until opened.
    const advanced = el('details', { className: 'olv-clip-advanced' });
    advanced.append(
      el('summary', { className: 'olv-clip-advanced-summary', text: 'Advanced' }),
      el('div', { className: 'olv-clip-grid-head' }, [
        el('span', { text: '' }), el('span', { text: 'min' }), el('span', { text: 'max' }),
      ]),
      grid,
    );
    this._advanced = advanced;

    this._readout = el('p', { className: 'olv-export-fullres-hint', text: '' });
    this._readout.setAttribute('role', 'status');
    this._readout.setAttribute('aria-live', 'polite');
    this._error = el('p', { className: 'olv-flow-selection-error olv-clip-error', text: '' });
    this._error.setAttribute('role', 'alert');

    const body = el('div', { className: 'olv-clip-body' }, [
      this._draw,
      enableLabel,
      el('div', { className: 'olv-bc-section-label', text: 'Mode' }),
      modeRow,
      actions,
      this._readout,
      this._error,
      advanced,
    ]);

    // Open from the start: the Clip page's Draw clipping box and Clear are its
    // first controls, and a folded panel would hide them behind its own head.
    this.element.append(head, body);
    this.setVisible(false);
  }

  /**
   * Flip the clip on or off exactly as the panel's own checkbox does. The
   * Tools launcher's Clip row runs this, so there is one write path and the
   * checkbox, the clip state and the viewer can never disagree.
   */
  toggleEnabled(): boolean {
    this._enabled = !this._enabled;
    this._enableBox.checked = this._enabled;
    this._apply();
    return this._enabled;
  }

  /** Whether the clip box is on. */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Give the Clip page its "Draw clipping box" entry point. The shell's
   * handler arms the existing Box measurement tool through the canonical
   * scene-tool command; until one is set the button stays hidden.
   */
  setOnDrawBox(fn: (() => void) | null): void {
    this._onDrawBox = fn;
    this._draw.classList.toggle('olv-hidden', fn === null);
  }

  /** Which side the clip keeps. */
  get mode(): ClipMode {
    return this._mode;
  }

  /** Whether the Advanced numeric fields are showing. */
  get advancedOpen(): boolean {
    return (this._advanced as HTMLDetailsElement).open === true;
  }

  /**
   * Run `fn` after every change to the clip's on/off state or side, however it
   * came about (checkbox, Clear, adopt, session restore, scan close). Returns
   * the unsubscribe. The active-clipping indicator is the one subscriber.
   */
  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  /** Turn the clip off, keeping the bounds, through the normal apply path. */
  clear(): void {
    this._enabled = false;
    this._enableBox.checked = false;
    this._apply();
  }

  private _emit(): void {
    for (const fn of [...this._listeners]) fn();
  }

  setVisible(on: boolean): void {
    this.element.style.display = on ? '' : 'none';
    if (!on) {
      // Hiding the panel (scan closed) clears the clip so it can't persist.
      this._cancelCount();
      this._enabled = false;
      this._enableBox.checked = false;
      this._cb.onApply(null);
      setClipScope(null);
      this._emit();
    }
  }

  /** Seed the box from the active cloud's bounds (also called on first reveal). */
  fitToScan(): void {
    this._fit();
  }

  /**
   * Apply a clip built elsewhere (the Measurements panel's "Use as clipping
   * region") through the NORMAL apply path: unlike {@link setState} this fires
   * `onApply`, so the viewer, the checkbox, the numeric bounds, the mode pills,
   * the readout and the clip scope all move together. The panel copies the
   * bounds; nothing links it back to where they came from.
   */
  adoptBounds(clip: ClipBox): void {
    // The user just asked for this clip: show its bounds, not a folded header.
    this.element.classList.remove('olv-collapsed');
    this._enabled = clip.enabled;
    this._enableBox.checked = clip.enabled;
    this._mode = clip.mode;
    this._paintMode();
    this._min = [clip.box.min[0], clip.box.min[1], clip.box.min[2]];
    this._max = [clip.box.max[0], clip.box.max[1], clip.box.max[2]];
    this._paintExtents();
    this._apply();
  }

  /**
   * The data under the clip changed (active scan, placement, resident nodes):
   * drop any pending count and, while the clip is on, count again.
   */
  invalidateCount(): void {
    this._cancelCount();
    if (this._enabled) this._scheduleCount();
  }

  /** Drop pending work; the panel stays usable but no queued count lands. */
  dispose(): void {
    this._cancelCount();
  }

  /**
   * Adopt an externally-restored clip (session import) WITHOUT firing
   * `onApply` — the caller has already pushed the clip to the viewer, and
   * re-applying through `_apply` while `_enabled` was still false is exactly
   * what used to clear a just-restored clip (clip-session finding, Critical).
   * Fills the internal state, the extent inputs, the mode pills, the enable
   * box, and the readout so the panel UI agrees with what the viewer is
   * actually clipping to.
   */
  setState(clip: ClipBox): void {
    // A pending count was queued for the PREVIOUS state — drop it.
    this._cancelCount();
    this._enabled = clip.enabled;
    this._enableBox.checked = clip.enabled;
    this._mode = clip.mode;
    this._paintMode();
    this._min = [clip.box.min[0], clip.box.min[1], clip.box.min[2]];
    this._max = [clip.box.max[0], clip.box.max[1], clip.box.max[2]];
    this._paintExtents();
    // Same readout _apply would show, minus the onApply side effect. A restore
    // is a one-off, so its count is taken straight away.
    if (this._enabled) {
      this._showCount(this._cb.keptCount(this._current()));
    } else {
      this._readout.textContent = 'Enable to clip the scan to the box.';
      setClipScope(null);
    }
    this._emit();
  }

  private _numInput(axis: Axis): HTMLInputElement {
    const input = el('input', { className: 'olv-bc-input olv-clip-num', type: 'number' }) as HTMLInputElement;
    input.step = 'any';
    input.addEventListener('input', () => this._editAxis(axis));
    return input;
  }

  /**
   * Take a numeric edit on one axis. Both of the axis's fields are read
   * together: the pair is applied only when each is a number and min is not
   * above max. Otherwise the clip keeps its last valid bounds and the message
   * says so, instead of applying a box that keeps nothing.
   */
  private _editAxis(axis: Axis): void {
    const lo = Number.parseFloat(this._minInputs[axis].value);
    const hi = Number.parseFloat(this._maxInputs[axis].value);
    const name = AXES[axis].label;
    let problem: string | null = null;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) problem = `${name} min or max is empty or not a number.`;
    else if (lo > hi) problem = `${name} min is above ${name} max.`;
    for (const input of [this._minInputs[axis], this._maxInputs[axis]]) {
      input.setAttribute('aria-invalid', problem ? 'true' : 'false');
    }
    if (problem) {
      this._fieldErrors.set(axis, `${problem} Not applied; the clip keeps ${name} ${fmt(this._min[axis])} to ${fmt(this._max[axis])}.`);
    } else {
      this._fieldErrors.delete(axis);
      this._min[axis] = lo;
      this._max[axis] = hi;
    }
    this._error.textContent = [...this._fieldErrors.values()].join(' ');
    if (!problem) this._apply();
  }

  private _setMode(mode: ClipMode): void {
    this._mode = mode;
    this._paintMode();
    this._apply();
  }

  private _paintMode(): void {
    for (const [m, btn] of this._modeBtns) {
      btn.classList.toggle('is-active', m === this._mode);
      btn.setAttribute('aria-pressed', m === this._mode ? 'true' : 'false');
    }
  }

  private _paintExtents(): void {
    // The fields are being set from a valid state, so any pending edit message is moot.
    this._fieldErrors.clear();
    this._error.textContent = '';
    for (const { axis } of AXES) {
      this._minInputs[axis].value = fmt(this._min[axis]);
      this._maxInputs[axis].value = fmt(this._max[axis]);
      this._minInputs[axis].setAttribute('aria-invalid', 'false');
      this._maxInputs[axis].setAttribute('aria-invalid', 'false');
    }
  }

  private _fit(): void {
    const b = this._cb.fitBounds();
    if (!b) return;
    this._min = [b.min[0], b.min[1], b.min[2]];
    this._max = [b.max[0], b.max[1], b.max[2]];
    this._paintExtents();
    this._apply();
  }

  private _current(): ClipBox {
    return { box: { min: [...this._min], max: [...this._max] }, mode: this._mode, enabled: this._enabled };
  }

  /**
   * Push the clip to the renderer NOW — the geometry is a handful of planes and
   * must follow every valid edit without lag — and move only the expensive part,
   * the O(N) kept-point count, behind a trailing timer so typing or holding a
   * spinner on a big scan never stalls. Until the count lands the readout says
   * it is updating rather than showing the previous number as current.
   */
  private _apply(): void {
    const clip = this._current();
    this._cancelCount();
    this._cb.onApply(this._enabled ? clip : null);
    this._emit();
    if (this._enabled) {
      // The clip scope keeps its last value until the new count lands, so its
      // consumers see one settled figure rather than a gap.
      this._readout.textContent = 'Updating kept-point count…';
      this._scheduleCount();
    } else {
      this._readout.textContent = 'Enable to clip the scan to the box.';
      setClipScope(null);
    }
  }

  private _cancelCount(): void {
    this._countGen++;
    if (this._countTimer !== null) { clearTimeout(this._countTimer); this._countTimer = null; }
  }

  private _scheduleCount(): void {
    const gen = this._countGen;
    this._countTimer = setTimeout(() => {
      this._countTimer = null;
      if (gen !== this._countGen || !this._enabled) return;
      const c = this._cb.keptCount(this._current());
      if (gen !== this._countGen) return; // superseded while counting
      this._showCount(c);
    }, CLIP_COUNT_DEBOUNCE_MS);
  }

  private _showCount(c: { kept: number; total: number } | null): void {
    this._readout.textContent = c
      ? `${c.kept.toLocaleString()} of ${c.total.toLocaleString()} points kept.`
      : '';
    setClipScope(c);
  }
}

/** Trailing quiet period before the kept-point count runs. */
export const CLIP_COUNT_DEBOUNCE_MS = 120;

/** A bound as typed: full precision, with only floating-point noise removed (0.0004 stays 0.0004). */
function fmt(v: number): string {
  return String(Number(v.toPrecision(12)));
}
