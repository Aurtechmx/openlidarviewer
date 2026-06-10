import { el } from './dom';

/**
 * The user-facing label for the "copy a link that reproduces the
 * current camera view" control. Single source of truth — the
 * constructor sets it on the button at creation time, and
 * `_flashShare()` restores it after the temporary "Link copied"
 * confirmation. The label is defined once here rather than inline at
 * each call site, so it cannot drift if it is ever retuned.
 */
const COPY_VIEW_LINK_LABEL = 'Copy view link';

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
  /** Toggle the Terrain analysis panel (re-open it if it was closed). */
  onAnalyseToggle: () => void;
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
  private readonly _analyse: HTMLButtonElement;
  private readonly _close: HTMLButtonElement;
  private readonly _more: HTMLButtonElement;

  constructor(callbacks: ToolDockCallbacks) {
    const frame = this._tool(
      'Frame',
      'Fit the whole scan back in view — also the R key',
      false,
    );
    frame.classList.add('olv-tool-frame');
    frame.addEventListener('click', callbacks.onFrameAll);

    const snapshot = this._tool(
      'Snapshot',
      'Save the current view as a PNG image — placed measurements and annotations included',
      false,
    );
    snapshot.classList.add('olv-tool-snapshot');
    snapshot.addEventListener('click', callbacks.onSnapshot);

    // "Copy view link" copies only the camera angle and viewport settings.
    // The recipient still has to open the *same scan file* on their own
    // device before the link does anything visible. This is a deliberate
    // consequence of the local-first architecture: scan data never leaves
    // the user's machine. The button label and tooltip below are written
    // to make that contract obvious at first read — earlier wording
    // ("Share") implied collaborative behaviour the architecture cannot
    // deliver, and recipients who clicked the link saw an empty viewer
    // and lost trust. v0.3.10.
    this._share = this._tool(
      COPY_VIEW_LINK_LABEL,
      'Copies the camera angle and view settings — not the scan itself. ' +
        'The recipient needs to open the same file first.',
      false,
    );
    this._share.addEventListener('click', () => {
      this._share.blur();
      callbacks.onShare();
      this._flashShare();
    });

    const help = this._tool('Help', 'Workflows, navigation and keyboard shortcuts — also the ? key', false);
    help.classList.add('olv-tool-help');
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

    // Analyse re-opens the Terrain analysis panel. The panel can be closed
    // (e.g. selecting the Profile measurement tucks it away to free the
    // canvas), so a dock toggle guarantees a one-click way back to it.
    this._analyse = this._tool('Analyse', 'Load a scan to enable terrain analysis', true);
    this._analyse.classList.add('olv-tool-analyse');
    this._analyse.addEventListener('click', () => {
      this._analyse.blur();
      callbacks.onAnalyseToggle();
    });

    // Toggle buttons must carry aria-pressed from creation — the attribute's
    // mere presence is what tells assistive tech "this is a toggle", so it
    // cannot wait for the first set*Active() call.
    for (const toggle of [this._measure, this._inspect, this._probe, this._annotate, this._analyse]) {
      toggle.setAttribute('aria-pressed', 'false');
    }

    // (Slice/Section was previously rendered here as a permanently
    // disabled button. A disabled tool in an active cluster reads as
    // broken rather than as a roadmap signal — Gestalt similarity
    // violation. The tool will land back in the dock when the
    // feature ships, alongside the other work tools.)

    // Close starts disabled — enabled by setCloseEnabled once a scan loads.
    // It clears the current scan and returns to the empty state.
    this._close = this._tool('Close', 'Load a scan to enable', true);
    this._close.classList.add('olv-tool-close');
    this._close.addEventListener('click', () => {
      this._close.blur();
      callbacks.onClose();
    });

    // Gestalt proximity: three explicit clusters in one rail.
    //   1. work tools  — Frame, Snapshot, Measure, Inspect, Probe,
    //      Annotate, Slice (the seven things you actually DO to a scan)
    //   2. meta tools  — Copy view link, Help (state about the scan, not edits)
    //   3. close       — its own destructive group at the far right
    // Each cluster boundary gets a wider left margin via the
    // `.olv-dock-gap` class so the user sees three groups instead
    // of one flat row of ten. Close keeps its rose tint so the
    // destructive role is also signalled by colour.
    this._share.classList.add('olv-dock-gap');
    this._close.classList.add('olv-dock-gap');
    // "More" disclosure for phones — hidden on desktop, shown on phones.
    // CSS hides Snapshot and Help by default on phones (they're low-value
    // when no keyboard is available). The "More" button toggles a
    // `.olv-dock-more-open` class on the dock that un-hides those two
    // buttons so the user can still reach them when needed. On desktop
    // every button is visible and the More toggle never appears.
    this._more = el('button', {
      className: 'olv-tool olv-tool-more',
      text: '•••',
      title: 'More tools — Snapshot, Analyse, Help',
      ariaLabel: 'Show more tools',
    });
    this._more.setAttribute('aria-expanded', 'false');
    this._more.addEventListener('click', () => {
      this._more.blur();
      const open = this.dock.classList.toggle('olv-dock-more-open');
      this._more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    this.dock = el('div', { className: 'olv-dock' }, [
      frame,
      snapshot,
      this._measure,
      this._inspect,
      this._probe,
      this._annotate,
      this._analyse,
      this._share,
      help,
      this._more,
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
    // aria-pressed is the canonical toggle-state signal for screen readers;
    // the class only restyles. The label stays 'Measure' in both states —
    // the old 'Measuring…' swap shifted the dock layout on every toggle.
    this._measure.classList.toggle('olv-tool-active', active);
    this._measure.setAttribute('aria-pressed', String(active));
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
    // Stable label + aria-pressed — see setMeasureActive for the rationale.
    this._inspect.classList.toggle('olv-tool-active', active);
    this._inspect.setAttribute('aria-pressed', String(active));
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
    // Stable label + aria-pressed — see setMeasureActive for the rationale.
    this._probe.classList.toggle('olv-tool-active', active);
    this._probe.setAttribute('aria-pressed', String(active));
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
    // Stable label + aria-pressed — see setMeasureActive for the rationale.
    this._annotate.classList.toggle('olv-tool-active', active);
    this._annotate.setAttribute('aria-pressed', String(active));
  }

  /** Enable or disable the Analyse tool — enabled once a scan is loaded. */
  setAnalyseEnabled(enabled: boolean): void {
    this._analyse.disabled = !enabled;
    this._analyse.title = enabled
      ? 'Show or hide the terrain analysis panel'
      : 'Load a scan to enable terrain analysis';
    if (!enabled) this.setAnalyseActive(false);
  }

  /** Reflect whether the terrain analysis panel is currently open. */
  setAnalyseActive(active: boolean): void {
    this._analyse.classList.toggle('olv-tool-active', active);
    this._analyse.setAttribute('aria-pressed', String(active));
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
      this._share.textContent = COPY_VIEW_LINK_LABEL;
      this._shareTimer = undefined;
    }, 2000);
  }

  private _tool(label: string, title: string, disabled: boolean): HTMLButtonElement {
    const button = el('button', { className: 'olv-tool', text: label, title });
    button.disabled = disabled;
    return button;
  }
}
