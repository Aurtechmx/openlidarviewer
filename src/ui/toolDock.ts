import { el } from './dom';

export interface ToolDockCallbacks {
  onFrameAll: () => void;
  onSnapshot: () => void;
  /** Toggle distance-measurement mode. */
  onMeasureToggle: () => void;
  /** Toggle point-inspection mode. */
  onInspectToggle: () => void;
  /** Close the current scan and return to the empty state. */
  onClose: () => void;
}

/**
 * The bottom-left tool dock and the bottom-right backend indicator.
 *
 * Frame and Snapshot are always available. Measure, Inspect and Close become
 * available once a scan is loaded — Measure toggles distance measurement,
 * Inspect toggles point inspection, Close clears the scan. Slice ships in v2.
 */
export class ToolDock {
  readonly dock: HTMLElement;
  readonly backend: HTMLElement;
  private readonly _backendText: HTMLElement;
  private readonly _measure: HTMLButtonElement;
  private readonly _inspect: HTMLButtonElement;
  private readonly _close: HTMLButtonElement;

  constructor(callbacks: ToolDockCallbacks) {
    const frame = this._tool(
      'Frame',
      'Fit the whole scan back in view — also the R key',
      false,
    );
    frame.addEventListener('click', callbacks.onFrameAll);

    const snapshot = this._tool(
      'Snapshot',
      'Save the current view as a PNG image to your device',
      false,
    );
    snapshot.addEventListener('click', callbacks.onSnapshot);

    // Measure starts disabled — enabled by setMeasureEnabled once a scan loads.
    this._measure = this._tool('Measure', 'Load a scan to enable measurement', true);
    this._measure.addEventListener('click', () => {
      this._measure.blur();
      callbacks.onMeasureToggle();
    });

    // Inspect starts disabled — enabled by setInspectEnabled once a scan loads.
    this._inspect = this._tool('Inspect', 'Load a scan to enable inspection', true);
    this._inspect.addEventListener('click', () => {
      this._inspect.blur();
      callbacks.onInspectToggle();
    });

    const slice = this._tool('Slice', 'Section & slice plane — coming soon', true);

    // Close starts disabled — enabled by setCloseEnabled once a scan loads.
    // It clears the current scan and returns to the empty state.
    this._close = this._tool('Close', 'Load a scan to enable', true);
    this._close.classList.add('olv-tool-close');
    this._close.addEventListener('click', () => {
      this._close.blur();
      callbacks.onClose();
    });

    this.dock = el('div', { className: 'olv-dock' }, [
      frame,
      snapshot,
      this._measure,
      this._inspect,
      slice,
      this._close,
    ]);

    this._backendText = el('span', { className: 'olv-backend-text', text: 'initialising…' });
    this.backend = el('div', { className: 'olv-backend' }, [
      el('span', { className: 'olv-backend-dot' }),
      this._backendText,
    ]);
  }

  /** Report which GPU backend the renderer initialised. */
  setBackend(backend: 'webgpu' | 'webgl2'): void {
    this._backendText.textContent = backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  }

  /** Enable or disable the Measure tool — enabled once a scan is loaded. */
  setMeasureEnabled(enabled: boolean): void {
    this._measure.disabled = !enabled;
    this._measure.title = enabled
      ? 'Measure distance, area, height, angle and slope on the scan'
      : 'Load a scan to enable measurement';
    if (!enabled) this.setMeasureActive(false);
  }

  /** Reflect whether measurement mode is currently active. */
  setMeasureActive(active: boolean): void {
    this._measure.classList.toggle('olv-tool-active', active);
    this._measure.textContent = active ? 'Measuring…' : 'Measure';
  }

  /** Enable or disable the Inspect tool — enabled once a scan is loaded. */
  setInspectEnabled(enabled: boolean): void {
    this._inspect.disabled = !enabled;
    this._inspect.title = enabled
      ? 'Click any point to read its coordinates and attributes'
      : 'Load a scan to enable inspection';
    if (!enabled) this.setInspectActive(false);
  }

  /** Reflect whether point-inspection mode is currently active. */
  setInspectActive(active: boolean): void {
    this._inspect.classList.toggle('olv-tool-active', active);
    this._inspect.textContent = active ? 'Inspecting…' : 'Inspect';
  }

  /** Enable or disable the Close action — enabled once a scan is loaded. */
  setCloseEnabled(enabled: boolean): void {
    this._close.disabled = !enabled;
    this._close.title = enabled
      ? 'Close the scan and return to the start'
      : 'Load a scan to enable';
  }

  private _tool(label: string, title: string, disabled: boolean): HTMLButtonElement {
    const button = el('button', { className: 'olv-tool', text: label, title });
    button.disabled = disabled;
    return button;
  }
}
