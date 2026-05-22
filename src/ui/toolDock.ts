import { el } from './dom';

export interface ToolDockCallbacks {
  onFrameAll: () => void;
  onSnapshot: () => void;
  /** Toggle distance-measurement mode. */
  onMeasureToggle: () => void;
  /** Toggle point-inspection mode. */
  onInspectToggle: () => void;
}

/**
 * The bottom-left tool dock and the bottom-right backend indicator.
 *
 * Frame and Snapshot are always available. Measure and Inspect become
 * available once a scan is loaded — Measure toggles distance measurement,
 * Inspect toggles point inspection. Slice ships in v2.
 */
export class ToolDock {
  readonly dock: HTMLElement;
  readonly backend: HTMLElement;
  private readonly _backendText: HTMLElement;
  private readonly _measure: HTMLButtonElement;
  private readonly _inspect: HTMLButtonElement;

  constructor(callbacks: ToolDockCallbacks) {
    const frame = this._tool('Frame', 'Fit the camera to all clouds', false);
    frame.addEventListener('click', callbacks.onFrameAll);

    const snapshot = this._tool('Snapshot', 'Save the current view as a PNG', false);
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

    this.dock = el('div', { className: 'olv-dock' }, [
      frame,
      snapshot,
      this._measure,
      this._inspect,
      slice,
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
      ? 'Measure straight-line distance'
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
      ? 'Inspect point attributes'
      : 'Load a scan to enable inspection';
    if (!enabled) this.setInspectActive(false);
  }

  /** Reflect whether point-inspection mode is currently active. */
  setInspectActive(active: boolean): void {
    this._inspect.classList.toggle('olv-tool-active', active);
    this._inspect.textContent = active ? 'Inspecting…' : 'Inspect';
  }

  private _tool(label: string, title: string, disabled: boolean): HTMLButtonElement {
    const button = el('button', { className: 'olv-tool', text: label, title });
    button.disabled = disabled;
    return button;
  }
}
