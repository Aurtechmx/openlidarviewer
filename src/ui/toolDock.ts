import { el } from './dom';

export interface ToolDockCallbacks {
  onFrameAll: () => void;
  onSnapshot: () => void;
  /** Copy a shareable link that reproduces the current view. */
  onShare: () => void;
  /** Toggle distance-measurement mode. */
  onMeasureToggle: () => void;
  /** Toggle point-inspection mode. */
  onInspectToggle: () => void;
  /** Toggle the live-probe (hover readout) mode. */
  onProbeToggle: () => void;
  /** Toggle annotation mode. */
  onAnnotateToggle: () => void;
  /** Open the help overlay. */
  onHelp: () => void;
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
  private readonly _share: HTMLButtonElement;
  private _shareTimer: number | undefined;
  private readonly _measure: HTMLButtonElement;
  private readonly _inspect: HTMLButtonElement;
  private readonly _probe: HTMLButtonElement;
  private readonly _annotate: HTMLButtonElement;
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
      'Save the current view as a PNG image — placed measurements and annotations included',
      false,
    );
    snapshot.addEventListener('click', callbacks.onSnapshot);

    // Share copies a link that reproduces the current view (camera, sizing) —
    // no scan data, just the viewpoint, for a recipient who opens the scan.
    this._share = this._tool(
      'Share',
      'Copy a link that reproduces this view — no scan data is shared',
      false,
    );
    this._share.addEventListener('click', () => {
      this._share.blur();
      callbacks.onShare();
      this._flashShare();
    });

    const help = this._tool('Help', 'Workflows, navigation and keyboard shortcuts — also the ? key', false);
    help.addEventListener('click', () => {
      help.blur();
      callbacks.onHelp();
    });

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

    // Probe starts disabled — enabled by setProbeEnabled once a scan loads.
    // It is a desktop-only hover affordance; CSS hides the button on phones.
    this._probe = this._tool('Probe', 'Load a scan to enable the live probe', true);
    this._probe.classList.add('olv-tool-probe');
    this._probe.addEventListener('click', () => {
      this._probe.blur();
      callbacks.onProbeToggle();
    });

    // Annotate starts disabled — enabled by setAnnotateEnabled once a scan loads.
    this._annotate = this._tool('Annotate', 'Load a scan to enable annotation', true);
    this._annotate.addEventListener('click', () => {
      this._annotate.blur();
      callbacks.onAnnotateToggle();
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

    // dock order. The work-tools (Measure → Annotate) cluster
    // first; meta-tools (Share + Help) sit to their right so the eye lands on
    // them as a group; Close anchors the far right with its own colour so
    // destructive separation is visually obvious.
    this.dock = el('div', { className: 'olv-dock' }, [
      frame,
      snapshot,
      this._measure,
      this._inspect,
      this._probe,
      this._annotate,
      slice,
      this._share,
      help,
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

  /**
   * Hide the entire dock while the user is on the empty state, reveal once a
   * scan attaches. v0.3.6 design-audit fix: showing eight dimmed tools on the
   * mobile empty state was a wall of visual noise that competed with the
   * primary CTA and pushed the catalog dropdown off-screen behind the dock.
   * Solved by collapsing the whole dock — the dimmed-tools UX still exists,
   * it just doesn't ship on a screen where no tool can ever be activated.
   */
  setEmpty(empty: boolean): void {
    this.dock.classList.toggle('olv-hidden', empty);
    this.backend.classList.toggle('olv-hidden', empty);
  }

  /** Enable or disable the Measure tool — enabled once a scan is loaded. */
  setMeasureEnabled(enabled: boolean): void {
    this._measure.disabled = !enabled;
    this._measure.title = enabled
      ? 'Measure distance, area, height, angle and slope on the scan — also the M key'
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
      ? 'Click any point to read its coordinates and attributes — also the I key'
      : 'Load a scan to enable inspection';
    if (!enabled) this.setInspectActive(false);
  }

  /** Reflect whether point-inspection mode is currently active. */
  setInspectActive(active: boolean): void {
    this._inspect.classList.toggle('olv-tool-active', active);
    this._inspect.textContent = active ? 'Inspecting…' : 'Inspect';
  }

  /** Enable or disable the live Probe — enabled once a scan is loaded. */
  setProbeEnabled(enabled: boolean): void {
    this._probe.disabled = !enabled;
    this._probe.title = enabled
      ? 'Hover the scan to read each point live, with no click'
      : 'Load a scan to enable the live probe';
    if (!enabled) this.setProbeActive(false);
  }

  /** Reflect whether live-probe mode is currently active. */
  setProbeActive(active: boolean): void {
    this._probe.classList.toggle('olv-tool-active', active);
    this._probe.textContent = active ? 'Probing…' : 'Probe';
  }

  /** Enable or disable the Annotate tool — enabled once a scan is loaded. */
  setAnnotateEnabled(enabled: boolean): void {
    this._annotate.disabled = !enabled;
    this._annotate.title = enabled
      ? 'Mark points of interest with notes and findings — also the A key'
      : 'Load a scan to enable annotation';
    if (!enabled) this.setAnnotateActive(false);
  }

  /** Reflect whether annotation mode is currently active. */
  setAnnotateActive(active: boolean): void {
    this._annotate.classList.toggle('olv-tool-active', active);
    this._annotate.textContent = active ? 'Annotating…' : 'Annotate';
  }

  /** Enable or disable the Close action — enabled once a scan is loaded. */
  setCloseEnabled(enabled: boolean): void {
    this._close.disabled = !enabled;
    this._close.title = enabled
      ? 'Close the scan and return to the start'
      : 'Load a scan to enable';
  }

  /** Briefly confirm a share link was copied, then restore the label. */
  private _flashShare(): void {
    if (this._shareTimer !== undefined) window.clearTimeout(this._shareTimer);
    this._share.textContent = 'Link copied';
    this._shareTimer = window.setTimeout(() => {
      this._share.textContent = 'Share';
      this._shareTimer = undefined;
    }, 2000);
  }

  private _tool(label: string, title: string, disabled: boolean): HTMLButtonElement {
    const button = el('button', { className: 'olv-tool', text: label, title });
    button.disabled = disabled;
    return button;
  }
}
