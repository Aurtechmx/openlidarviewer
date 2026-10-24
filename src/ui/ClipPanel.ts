/**
 * ClipPanel.ts — the clip-box control.
 *
 * A compact left panel that drives the viewer's axis-aligned clip box. The
 * primary controls are Draw clipping box, the on/off switch, Keep inside vs
 * Keep outside, Fit to scan and Turn off, with a live "kept of total"
 * readout; the six numeric extents sit behind an Advanced disclosure (a native
 * <details>, collapsed by default, whose nodes are built once and never
 * recreated).
 *
 * Numeric edits: an arrow-key or wheel step on a focused field applies at
 * once (0.1 of the scene unit, 1 with Shift). Typed text applies when it is
 * committed (Enter, or leaving the field); a field left holding a value that
 * cannot be applied returns to the last valid bound. Fields show three
 * decimals, and a field the user did not touch keeps the bound's full
 * precision when its axis is applied.
 *
 * The keep/cull decision and the count are the pure `clipBox` core; this panel
 * is only the DOM around it. The box itself is drawn in the scene by the
 * viewer (`onOutline`) while the clip is on or this page is open.
 */

import { el } from './dom';
import type { ClipBox, ClipMode } from '../render/clip/clipBox';
import type { BoxBounds } from '../render/measure/geometry';
import { setClipScope } from '../render/clip/clipScope';

export { fitBoundsInProject } from '../render/clip/fitBoundsInProject';

/** What a kept-point count knows about the scans under the clip. */
export interface ClipKeptCount {
  /** Points the clip keeps in the active scan (what a point-cloud export writes). */
  readonly kept: number;
  /** Points the active scan holds. */
  readonly total: number;
  /** The source file's declared point count when the active scan holds a display sample of it. */
  readonly sourceTotal?: number | null;
  /** Kept and total over every visible scan, when more than one is visible. */
  readonly visible?: { readonly kept: number; readonly total: number; readonly scans: number } | null;
  /** The active scan's name, shown when several scans are counted. */
  readonly name?: string | null;
}

export interface ClipPanelCallbacks {
  /** Apply the clip (or `null`/disabled to clear it) to the viewer. */
  onApply: (clip: ClipBox | null) => void;
  /** The visible scans' bounds, to seed the box from "Fit to scan". */
  fitBounds: () => BoxBounds | null;
  /** Exact kept/total count for a clip against the visible scans (CPU), or null when it cannot be counted. */
  keptCount: (clip: ClipBox) => ClipKeptCount | null;
  /** Draw the box in the scene (`null` hides it); `active` is true while the clip is on. */
  onOutline?: (box: BoxBounds | null, active: boolean) => void;
  /** The scene frame's unit per axis: 'm', 'ft', '°', or '' when unknown. */
  units?: () => readonly [string, string, string];
}

type Axis = 0 | 1 | 2;
const AXES: ReadonlyArray<{ axis: Axis; label: string }> = [
  { axis: 0, label: 'X' },
  { axis: 1, label: 'Y' },
  { axis: 2, label: 'Z' },
];

const MODE_LABEL: Record<ClipMode, string> = { 'keep-inside': 'Keep inside', 'keep-outside': 'Keep outside' };
const OFF_TEXT = 'Clipping is off. Tick "Clip the scan to this box" to apply the box.';
const COUNTING_TEXT = 'Counting the kept points…';
const NO_COUNT_TEXT = 'The clip hides the points outside the box as they load. A kept-point count is not available for a streaming scan.';

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
  /** True once a count has been shown for the current clip; a recount dims it rather than blanking it. */
  private _hasCount = false;
  private readonly _minInputs: HTMLInputElement[] = [];
  private readonly _maxInputs: HTMLInputElement[] = [];
  /** The text each field was last painted with: an untouched field keeps its bound's full precision. */
  private readonly _painted = new Map<HTMLInputElement, string>();
  private readonly _enableBox: HTMLInputElement;
  private readonly _modeBtns = new Map<ClipMode, HTMLButtonElement>();
  private readonly _readout: HTMLElement;
  /** Inline message for numeric edits that were not applied. */
  private readonly _error: HTMLElement;
  private readonly _fieldErrors = new Map<Axis, string>();
  private readonly _listeners = new Set<() => void>();
  private readonly _advanced: HTMLElement;
  private readonly _frame: HTMLElement;
  private readonly _draw: HTMLButtonElement;
  private readonly _drawHint: HTMLElement;
  private readonly _turnOff: HTMLButtonElement;
  private _onDrawBox: (() => void) | null = null;
  /** The Clip page is the one on screen: the box is drawn even while the clip is off. */
  private _pageOpen = false;
  /** Wheel travel not yet turned into a step (a trackpad sends many small deltas). */
  private _wheelTravel = 0;

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
    (['keep-inside', 'keep-outside'] as const).forEach((mode) => {
      const btn = el('button', {
        className: `olv-bc-pill${this._mode === mode ? ' is-active' : ''}`,
        type: 'button',
        text: MODE_LABEL[mode],
        title: mode === 'keep-inside' ? 'Show only the points inside the box' : 'Hide the points inside the box',
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
      title: 'Reset the box to the full extent of the visible scans.',
    }) as HTMLButtonElement;
    fit.addEventListener('click', () => this._fit());
    this._turnOff = el('button', {
      className: 'olv-bc-pill olv-clip-clear', type: 'button', text: 'Turn off',
      title: 'Turn the clip off and show the whole scan. The box and its bounds stay.',
    }) as HTMLButtonElement;
    this._turnOff.addEventListener('click', () => this.clear());
    const actions = el('div', { className: 'olv-bc-pills olv-clip-actions' }, [fit, this._turnOff]);

    this._draw = el('button', {
      className: 'olv-bc-pill olv-clip-draw olv-hidden', type: 'button', text: 'Draw clipping box',
      title: 'Click two opposite corners on the scan. The clip keeps that footprint at the scan\'s full height.',
    }) as HTMLButtonElement;
    this._draw.addEventListener('click', () => this._onDrawBox?.());
    // Announced politely; not a second status role beside the readout.
    this._drawHint = el('p', { className: 'olv-clip-draw-hint olv-hidden', text: '' });
    this._drawHint.setAttribute('aria-live', 'polite');

    this._readout = el('p', { className: 'olv-export-fullres-hint olv-clip-readout', text: '' });
    this._readout.setAttribute('role', 'status');
    this._readout.setAttribute('aria-live', 'polite');
    this._error = el('p', { className: 'olv-flow-selection-error olv-clip-error', text: '' });
    this._error.setAttribute('role', 'alert');
    this._frame = el('p', { className: 'olv-clip-frame', text: '' });

    // Advanced: the six numeric extents. A native disclosure, closed until opened.
    // The message for an edit that was not applied sits below the fields, so
    // showing or clearing it never moves the field being typed in.
    const advanced = el('details', { className: 'olv-clip-advanced' });
    advanced.append(
      el('summary', { className: 'olv-clip-advanced-summary', text: 'Advanced' }),
      this._frame,
      el('div', { className: 'olv-clip-grid-head' }, [
        el('span', { text: '' }), el('span', { text: 'min' }), el('span', { text: 'max' }),
      ]),
      grid,
      this._error,
    );
    this._advanced = advanced;
    // A wheel anywhere on the panel but the focused field ends that field's
    // edit, so scrolling the page can never step a bound the pointer has left.
    this.element.addEventListener('wheel', (e) => this._onPanelWheel(e as WheelEvent), { passive: true });

    const body = el('div', { className: 'olv-clip-body' }, [
      this._draw,
      this._drawHint,
      enableLabel,
      el('div', { className: 'olv-bc-section-label', text: 'Mode' }),
      modeRow,
      actions,
      this._readout,
      advanced,
    ]);

    // Open from the start: the Clip page's Draw clipping box and Turn off are its
    // first controls, and a folded panel would hide them behind its own head.
    this.element.append(head, body);
    this._paintFrame();
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
   * handler arms the existing Box measurement tool; until one is set the
   * button stays hidden.
   */
  setOnDrawBox(fn: (() => void) | null): void {
    this._onDrawBox = fn;
    this._draw.classList.toggle('olv-hidden', fn === null);
  }

  /**
   * The Box tool's corner hint while a clipping box is being drawn, shown on
   * this page under Draw clipping box; `null` when no box is being drawn.
   */
  setDrawHint(text: string | null): void {
    const on = text !== null && text !== '';
    if (this._drawHint.textContent !== (on ? text : '')) this._drawHint.textContent = on ? text : '';
    this._drawHint.classList.toggle('olv-hidden', !on);
    this._draw.classList.toggle('is-active', on);
    this._draw.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /** Whether the Clip page is the page on screen; the box is drawn while it is. */
  setPageOpen(open: boolean): void {
    if (this._pageOpen === open) return;
    this._pageOpen = open;
    this._paintFrame();
    this._syncOutline();
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
   * came about (checkbox, Turn off, adopt, session restore, scan close). Returns
   * the unsubscribe. The active-clipping indicator is one subscriber.
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
      this._hasCount = false;
      this._enabled = false;
      this._enableBox.checked = false;
      this._cb.onApply(null);
      this._cb.onOutline?.(null, false);
      setClipScope(null);
      this._renderOff();
      this._emit();
    } else {
      this._paintFrame();
    }
  }

  /** Seed the box from the visible scans' bounds (also called on first reveal). */
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
   * The data under the clip changed (active scan, a layer added or removed or
   * shown or hidden, placement, a reload at another density): drop any pending
   * count and, while the clip is on, count again. The last figure stays on
   * screen, dimmed, until the new one lands.
   */
  invalidateCount(): void {
    this._cancelCount();
    this._paintFrame();
    if (this._enabled) {
      this._markCounting();
      this._scheduleCount();
    }
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
    this._syncOutline();
    // Same readout _apply would show, minus the onApply side effect. A restore
    // is a one-off, so its count is taken straight away.
    if (this._enabled) {
      this._showCount(this._cb.keptCount(this._current()));
    } else {
      this._renderOff();
      setClipScope(null);
    }
    this._emit();
  }

  private _numInput(axis: Axis): HTMLInputElement {
    const input = el('input', { className: 'olv-bc-input olv-clip-num', type: 'number' }) as HTMLInputElement;
    input.step = 'any';
    input.inputMode = 'decimal';
    // Typed text (an InputEvent) waits for Enter or blur; a browser spin
    // (a plain Event from the spin buttons) applies at once.
    input.addEventListener('input', (e) => {
      if (typedInput(e)) input.classList.toggle('is-pending', input.value !== this._painted.get(input));
      else this._commitAxis(axis);
    });
    input.addEventListener('change', () => this._commitAxis(axis));
    input.addEventListener('keydown', (e) => this._onFieldKey(e as KeyboardEvent, axis, input));
    input.addEventListener('blur', (e) => this._onFieldBlur(e as FocusEvent, axis));
    input.addEventListener('wheel', (e) => this._onFieldWheel(e as WheelEvent, axis, input), { passive: false });
    return input;
  }

  /** Arrow keys step the focused bound and apply at once; Enter applies; Escape puts the axis back. */
  private _onFieldKey(e: KeyboardEvent, axis: Axis, input: HTMLInputElement): void {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      this._step(axis, input, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey === true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this._commitAxis(axis);
    } else if (e.key === 'Escape' && this._axisDirty(axis)) {
      e.preventDefault();
      e.stopPropagation();
      this._restoreAxis(axis, null);
    }
  }

  /**
   * A wheel over the focused field steps it like an arrow key; over an
   * unfocused one it does nothing here, so the panel scrolls as usual.
   */
  private _onFieldWheel(e: WheelEvent, axis: Axis, input: HTMLInputElement): void {
    if (!isFocused(input)) return;
    e.preventDefault();
    this._wheelTravel += e.deltaY;
    if (Math.abs(this._wheelTravel) < WHEEL_STEP_TRAVEL) return;
    const dir = this._wheelTravel < 0 ? 1 : -1;
    this._wheelTravel = 0;
    this._step(axis, input, dir, e.shiftKey === true);
  }

  /** A wheel elsewhere on the panel ends the focused field's edit before it can step it. */
  private _onPanelWheel(e: WheelEvent): void {
    const active = typeof document === 'undefined' ? null : (document.activeElement as HTMLInputElement | null);
    if (!active || e.target === active) return;
    if (this._minInputs.includes(active) || this._maxInputs.includes(active)) active.blur();
  }

  /**
   * Leaving a field applies its axis. A value that cannot be applied returns
   * to the last valid bound, unless focus is moving to the axis's other field
   * (where the user is fixing the pair).
   */
  private _onFieldBlur(e: FocusEvent, axis: Axis): void {
    this._wheelTravel = 0;
    const next = e.relatedTarget as HTMLInputElement | null;
    const pair = [this._minInputs[axis], this._maxInputs[axis]];
    if (this._commitAxis(axis)) return;
    if (next && pair.includes(next)) return;
    this._restoreAxis(axis, this._fieldErrors.get(axis) ?? null);
  }

  /** Step a bound by 0.1 of the scene unit (1 with Shift) from what the field shows, and apply. */
  private _step(axis: Axis, input: HTMLInputElement, dir: 1 | -1, coarse: boolean): void {
    const isMin = this._minInputs[axis] === input;
    const stored = isMin ? this._min[axis] : this._max[axis];
    const from = this._readField(input, stored);
    const base = Number.isFinite(from) ? from : stored;
    const step = stepFor(this._unit(axis)) * (coarse ? 10 : 1);
    const v = roundTo(base + dir * step, this._decimals(axis));
    input.value = this._fmt(axis, v);
    this._commitAxis(axis);
  }

  /** A field's value: the stored bound at full precision when the field still shows what was painted. */
  private _readField(input: HTMLInputElement, stored: number): number {
    if (input.value === this._painted.get(input)) return stored;
    const t = String(input.value ?? '').trim();
    return t === '' ? Number.NaN : Number(t);
  }

  private _axisDirty(axis: Axis): boolean {
    return [this._minInputs[axis], this._maxInputs[axis]].some((i) => i.value !== this._painted.get(i));
  }

  /**
   * Take a numeric edit on one axis. Both of the axis's fields are read
   * together: the pair is applied only when each is a number and min is not
   * above max. Otherwise the clip keeps its last valid bounds and the message
   * under the fields says so, instead of applying a box that keeps nothing.
   * Returns true when the axis holds a valid pair (applied, or unchanged).
   */
  private _commitAxis(axis: Axis): boolean {
    const lo = this._readField(this._minInputs[axis], this._min[axis]);
    const hi = this._readField(this._maxInputs[axis], this._max[axis]);
    const name = AXES[axis].label;
    let problem: string | null = null;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) problem = `${name} min or max is empty or not a number.`;
    else if (lo > hi) problem = `${name} min is above ${name} max.`;
    for (const input of [this._minInputs[axis], this._maxInputs[axis]]) {
      input.setAttribute('aria-invalid', problem ? 'true' : 'false');
    }
    if (problem) {
      this._fieldErrors.set(axis, `${problem} Not applied; the clip keeps ${name} ${this._fmt(axis, this._min[axis], -1)} to ${this._fmt(axis, this._max[axis], 1)}.`);
      this._paintErrors();
      return false;
    }
    this._fieldErrors.delete(axis);
    this._paintErrors();
    const changed = lo !== this._min[axis] || hi !== this._max[axis];
    this._min[axis] = lo;
    this._max[axis] = hi;
    this._paintAxis(axis);
    if (changed) this._apply();
    return true;
  }

  /** Put an axis's fields back to the last valid bounds; `note` says why, or null for none. */
  private _restoreAxis(axis: Axis, note: string | null): void {
    this._fieldErrors.delete(axis);
    this._paintAxis(axis);
    const name = AXES[axis].label;
    const back = note
      ? `${note.replace(/ Not applied;.*$/, '')} ${name} is back to ${this._fmt(axis, this._min[axis], -1)} to ${this._fmt(axis, this._max[axis], 1)}.`
      : '';
    this._error.textContent = [...this._fieldErrors.values(), back].filter(Boolean).join(' ');
  }

  private _paintErrors(): void {
    this._error.textContent = [...this._fieldErrors.values()].join(' ');
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

  private _paintAxis(axis: Axis): void {
    for (const [input, v, side] of [[this._minInputs[axis], this._min[axis], -1], [this._maxInputs[axis], this._max[axis], 1]] as const) {
      // Rounded outward, so the box the fields show always holds the box applied
      // (typing a shown value back never trims a point at the edge).
      const text = this._fmt(axis, v, side);
      input.value = text;
      this._painted.set(input, text);
      input.setAttribute('aria-invalid', 'false');
      input.classList.remove('is-pending');
    }
  }

  private _paintExtents(): void {
    // The fields are being set from a valid state, so any pending edit message is moot.
    this._fieldErrors.clear();
    this._error.textContent = '';
    for (const { axis } of AXES) this._paintAxis(axis);
  }

  /** The frame and unit the bounds are in, and how the fields step. */
  private _paintFrame(): void {
    const text = frameText(this._units());
    if (this._frame.textContent !== text) this._frame.textContent = text;
  }

  private _units(): readonly [string, string, string] {
    try {
      return this._cb.units?.() ?? ['', '', ''];
    } catch {
      return ['', '', ''];
    }
  }

  private _unit(axis: Axis): string {
    return this._units()[axis] ?? '';
  }

  private _decimals(axis: Axis): number {
    return this._unit(axis) === '°' ? 7 : 3;
  }

  /** A bound for display; `side` -1 rounds a minimum down, 1 a maximum up, 0 to nearest. */
  private _fmt(axis: Axis, v: number, side: -1 | 0 | 1 = 0): string {
    const d = this._decimals(axis);
    if (side === 0) return fmt(v, d);
    const k = 10 ** d;
    // The epsilon keeps floating-point noise (0.1 + 0.2) from moving a value a whole step.
    return fmt((side < 0 ? Math.floor(v * k + 1e-6) : Math.ceil(v * k - 1e-6)) / k, d);
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

  /** Draw the box while the clip is on or this page is open; hide it otherwise. */
  private _syncOutline(): void {
    const show = this._enabled || this._pageOpen;
    this._cb.onOutline?.(show ? { min: [...this._min], max: [...this._max] } : null, this._enabled);
  }

  /**
   * Push the clip to the renderer NOW — the geometry is a handful of uniforms
   * and must follow every applied edit without lag — and move only the
   * expensive part, the O(N) kept-point count, behind a trailing timer so a
   * held arrow key on a big scan never stalls. Until the count lands the
   * previous figure stays, dimmed and marked busy, rather than reading as
   * current or blinking out.
   */
  private _apply(): void {
    const clip = this._current();
    this._cancelCount();
    this._cb.onApply(this._enabled ? clip : null);
    this._syncOutline();
    this._syncTurnOff();
    this._emit();
    if (this._enabled) {
      // The clip scope keeps its last value until the new count lands, so its
      // consumers see one settled figure rather than a gap.
      this._markCounting();
      this._scheduleCount();
    } else {
      this._hasCount = false;
      this._renderOff();
      setClipScope(null);
    }
  }

  /** Turn off has nothing to do while the clip is off. */
  private _syncTurnOff(): void {
    this._turnOff.disabled = !this._enabled;
    this._turnOff.classList.toggle('is-disabled', !this._enabled);
  }

  private _renderOff(): void {
    this._readout.classList.remove('is-stale');
    this._readout.removeAttribute('aria-busy');
    this._readout.textContent = OFF_TEXT;
    this._syncTurnOff();
  }

  /** The count is being redone: dim the last figure, or say it is counting when there is none. */
  private _markCounting(): void {
    if (this._hasCount) {
      this._readout.classList.add('is-stale');
      this._readout.setAttribute('aria-busy', 'true');
    } else {
      this._readout.classList.remove('is-stale');
      this._readout.textContent = COUNTING_TEXT;
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

  private _showCount(c: ClipKeptCount | null): void {
    this._readout.classList.remove('is-stale');
    this._readout.removeAttribute('aria-busy');
    this._readout.textContent = clipReadoutText(c, this._mode);
    this._hasCount = c !== null;
    this._syncTurnOff();
    setClipScope(c ? { kept: c.kept, total: c.total } : null);
  }
}

/** Trailing quiet period before the kept-point count runs. */
export const CLIP_COUNT_DEBOUNCE_MS = 120;

/** Wheel travel (in pixels of deltaY) per step on a focused field. */
const WHEEL_STEP_TRAVEL = 50;

/** True for an input event that carries typed, pasted or deleted text (an InputEvent), not a spin. */
function typedInput(e: Event): boolean {
  const t = (e as InputEvent).inputType;
  return typeof t === 'string' && t !== '';
}

function isFocused(node: HTMLElement): boolean {
  return typeof document !== 'undefined' && document.activeElement === node;
}

/** The fine arrow step for an axis unit: 0.1 of a linear unit, about 0.1 m in degrees. */
function stepFor(unit: string): number {
  return unit === '°' ? 0.000001 : 0.1;
}

/**
 * The line above the fields: which frame the bounds are in, in which unit,
 * and how they step. The frame is the scene's local one, the frame of the
 * Inspect card's Local X, Y, Z (three decimals there too).
 */
export function frameText(u: readonly [string, string, string]): string {
  const name = (x: string): string => (x === '°' ? '°' : x ? ` ${x}` : ' scene units');
  const fine = (x: string): string => (x === '°' ? '0.000001°' : `0.1${name(x)}`);
  const coarse = (x: string): string => (x === '°' ? '0.00001°' : `1${name(x)}`);
  const same = u[0] === u[1] && u[1] === u[2];
  const unit = same ? (u[0] === '°' ? 'degrees' : u[0] || 'scene units') : u.map((x) => x || 'scene units').join(', ');
  const step = same ? `${fine(u[0])}, Shift ${coarse(u[0])}` : `${fine(u[0])} across and ${fine(u[2])} up, Shift ten times that`;
  return `Bounds in local scene coordinates (${unit}). Arrow keys step ${step}. Typed values apply on Enter.`;
}

function roundTo(v: number, decimals: number): number {
  const k = 10 ** decimals;
  return Math.round(v * k) / k;
}

/** A bound for display: fixed decimals, and never "-0.000". */
function fmt(v: number, decimals = 3): string {
  const s = v.toFixed(decimals);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}

const count = (n: number): string => n.toLocaleString('en-US');

/** "151.1 M" for millions, otherwise the exact count. */
function approx(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : count(Math.round(n));
}

/**
 * The readout under the Clip page's controls, from a kept-point count. Says
 * which points were counted (the shown display sample, several visible scans),
 * what a full-resolution export would keep, and why the figure is all or
 * nothing when it is.
 */
export function clipReadoutText(c: ClipKeptCount | null, mode: ClipMode): string {
  if (!c) return NO_COUNT_TEXT;
  const multi = c.visible && c.visible.scans > 1 ? c.visible : null;
  const sample = c.sourceTotal != null && c.sourceTotal > c.total ? c.sourceTotal : null;
  const kept = multi ? multi.kept : c.kept;
  const total = multi ? multi.total : c.total;
  const parts: string[] = [];
  if (multi) {
    parts.push(`${count(kept)} of ${count(total)} ${sample ? 'shown ' : ''}points kept across ${multi.scans} visible scans.`);
    parts.push(`In the active scan${c.name ? ` (${c.name})` : ''}: ${count(c.kept)} of ${count(c.total)}; a point-cloud export writes these.`);
  } else {
    parts.push(`${count(kept)} of ${count(total)} ${sample ? 'shown ' : ''}points kept.`);
  }
  if (sample && c.total > 0 && c.kept > 0) {
    parts.push(`A full-resolution export keeps about ${approx((c.kept / c.total) * sample)} of the file's ${approx(sample)} points.`);
  }
  const whole = multi ? 'every visible scan' : 'the whole scan';
  if (total > 0 && kept === total && mode === 'keep-inside') {
    parts.push(`The box covers ${whole}. Draw a clipping box, or edit the bounds under Advanced, to make it smaller.`);
  } else if (total > 0 && kept === 0 && mode === 'keep-outside') {
    parts.push(`The box covers ${whole} and Keep outside hides what is inside it. Draw a smaller box, or switch to Keep inside.`);
  } else if (total > 0 && kept === 0) {
    parts.push('No points are inside the box. Move or resize it, or use Fit to scan.');
  } else if (total > 0 && kept === total) {
    parts.push('No points are inside the box, so Keep outside hides nothing.');
  }
  return parts.join(' ');
}
