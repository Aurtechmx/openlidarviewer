import { el } from './dom';

export interface ToolDockCallbacks {
  onFrameAll: () => void;
  onSnapshot: () => void;
}

/**
 * The bottom-left tool dock and the bottom-right backend indicator. Measure
 * and Slice are present but disabled — they ship in v2.
 */
export class ToolDock {
  readonly dock: HTMLElement;
  readonly backend: HTMLElement;
  private readonly _backendText: HTMLElement;

  constructor(callbacks: ToolDockCallbacks) {
    const frame = this._tool('Frame', 'Fit the camera to all clouds', false);
    frame.addEventListener('click', callbacks.onFrameAll);

    const snapshot = this._tool('Save PNG', 'Save the current view as a PNG', false);
    snapshot.addEventListener('click', callbacks.onSnapshot);

    const measure = this._tool('Measure', 'Measure distance and area — ships in v2', true);
    const slice = this._tool('Slice', 'Slice / section plane — ships in v2', true);

    this.dock = el('div', { className: 'olv-dock' }, [frame, snapshot, measure, slice]);

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

  private _tool(label: string, title: string, disabled: boolean): HTMLButtonElement {
    const button = el('button', { className: 'olv-tool', text: label, title });
    button.disabled = disabled;
    return button;
  }
}
