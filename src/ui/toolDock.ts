import { el } from './dom';

export interface ToolDockCallbacks {
  onFrameAll: () => void;
  onSnapshot: () => void;
  /** Toggle distance-measurement mode. */
  onMeasureToggle: () => void;
}

/**
 * The bottom-left tool dock and the bottom-right backend indicator.
 *
 * Frame and Save PNG are always available. Measure becomes available once a
 * scan is loaded and toggles distance-measurement mode. Slice ships in v2.
 */
export class ToolDock {
  readonly dock: HTMLElement;
  readonly backend: HTMLElement;
  private readonly _backendText: HTMLElement;
  private readonly _measure: HTMLButtonElement;

  constructor(callbacks: ToolDockCallbacks) {
    const frame = this._tool('Frame', 'Fit the camera to all clouds', false);
    frame.addEventListener('click', callbacks.onFrameAll);

    const snapshot = this._tool('Save PNG', 'Save the current view as a PNG', false);
    snapshot.addEventListener('click', callbacks.onSnapshot);

    // Measure starts disabled — enabled by setMeasureEnabled once a scan loads.
    this._measure = this._tool('Measure', 'Measure straight-line distance', true);
    this._measure.addEventListener('click', () => {
      this._measure.blur();
      callbacks.onMeasureToggle();
    });

    const slice = this._tool('Slice', 'Slice / section plane — ships in v2', true);

    this.dock = el('div', { className: 'olv-dock' }, [frame, snapshot, this._measure, slice]);

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
    if (!enabled) this.setMeasureActive(false);
  }

  /** Reflect whether measurement mode is currently active. */
  setMeasureActive(active: boolean): void {
    this._measure.classList.toggle('olv-tool-active', active);
    this._measure.textContent = active ? 'Measuring…' : 'Measure';
  }

  private _tool(label: string, title: string, disabled: boolean): HTMLButtonElement {
    const button = el('button', { className: 'olv-tool', text: label, title });
    button.disabled = disabled;
    return button;
  }
}
