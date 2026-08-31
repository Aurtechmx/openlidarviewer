import { el } from './dom';
import { backendLabel } from './backendLabel';
import {
  ICON_FRAME,
  ICON_SNAPSHOT,
  ICON_LINK,
  ICON_HELP,
  ICON_COMMAND,
  ICON_MEASURE,
  ICON_INSPECT,
  ICON_PROBE,
  ICON_ANNOTATE,
  ICON_ANALYSE,
  ICON_CLOSE,
} from './dockIcons';

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
  /** Open the command palette (also Cmd/Ctrl-K). */
  onCommandPalette: () => void;
  /** Close the current scan and return to the empty state. */
  onClose: () => void;
}

/**
 * One entry in the ordered dock manifest. `title` is the button's initial
 * tooltip (the disabled-state string for a scan-enabled tool); `enabledTitle`,
 * when present, is swapped in by `setEnabled(id, true)`. `toggle` marks a
 * button that carries aria-pressed and an active state. `custom` builds a
 * button that does not fit the icon+label template (the "More" disclosure).
 */
interface DockToolSpec {
  id: string;
  label: string;
  title: string;
  enabledTitle?: string;
  icon?: string;
  classes?: string[];
  disabled?: boolean;
  toggle?: boolean;
  blur?: boolean;
  onClick?: () => void;
  custom?: () => HTMLButtonElement;
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
  /** Every dock button, keyed by its manifest id, for id-driven patching. */
  private readonly _buttons = new Map<string, HTMLButtonElement>();
  /** Per-tool enabled/disabled tooltip strings for `setEnabled`. */
  private readonly _titles = new Map<string, { enabled: string; disabled: string }>();
  /** Ids of the toggle tools (those carrying aria-pressed / an active state). */
  private readonly _toggles = new Set<string>();

  constructor(callbacks: ToolDockCallbacks) {
    // The dock is one ordered manifest. Each entry names a button, its tooltip
    // (and — for the tools a scan enables — both enabled and disabled tooltip
    // strings), its extra CSS classes, whether it is a toggle (carries
    // aria-pressed and an active state) and its click behaviour. The render
    // order below IS the on-screen order; id-keyed `setEnabled`/`setActive`
    // patch a single button. The mobile stylesheets key off the per-tool
    // classes, so every class here is load-bearing.
    const specs: DockToolSpec[] = [
      {
        id: 'tool.frame',
        label: 'Frame',
        title: 'Fit the whole scan back in view — also the R key',
        icon: ICON_FRAME,
        classes: ['olv-tool-frame'],
        onClick: callbacks.onFrameAll,
      },
      {
        id: 'tool.snapshot',
        label: 'Snapshot',
        title:
          'Save the current view as a PNG image — placed measurements and annotations included',
        icon: ICON_SNAPSHOT,
        classes: ['olv-tool-snapshot'],
        onClick: callbacks.onSnapshot,
      },
      // Measure starts disabled — enabled by setEnabled('tool.measure') once a
      // scan loads. The `olv-dock-measure` class is a stable hook for the
      // onboarding tour's spotlight (v0.4.5): the tour's only other selector
      // keys off the tooltip text, which changes with enablement, so the
      // spotlight used to miss the disabled button.
      {
        id: 'tool.measure',
        label: 'Measure',
        title: 'Load a scan to enable measurement',
        enabledTitle:
          'Measure distance, area, height, angle and slope on the scan — also the M key',
        icon: ICON_MEASURE,
        classes: ['olv-dock-measure'],
        disabled: true,
        toggle: true,
        blur: true,
        onClick: callbacks.onMeasureToggle,
      },
      {
        id: 'tool.inspect',
        label: 'Inspect',
        title: 'Load a scan to enable inspection',
        enabledTitle: 'Click any point to read its coordinates and attributes — also the I key',
        icon: ICON_INSPECT,
        disabled: true,
        toggle: true,
        blur: true,
        onClick: callbacks.onInspectToggle,
      },
      // Probe is a desktop-only hover affordance; CSS hides the button on phones.
      {
        id: 'tool.probe',
        label: 'Probe',
        title: 'Load a scan to enable the live probe',
        enabledTitle: 'Hover the scan to read each point live, with no click',
        icon: ICON_PROBE,
        classes: ['olv-tool-probe'],
        disabled: true,
        toggle: true,
        blur: true,
        onClick: callbacks.onProbeToggle,
      },
      {
        id: 'tool.annotate',
        label: 'Annotate',
        title: 'Load a scan to enable annotation',
        enabledTitle: 'Mark points of interest with notes and findings — also the A key',
        icon: ICON_ANNOTATE,
        disabled: true,
        toggle: true,
        blur: true,
        onClick: callbacks.onAnnotateToggle,
      },
      // Analyse re-opens the Terrain analysis panel. The panel can be closed
      // (e.g. selecting the Profile measurement tucks it away to free the
      // canvas), so a dock toggle guarantees a one-click way back to it.
      {
        id: 'tool.analyse',
        label: 'Analyse',
        title: 'Load a scan to enable terrain analysis',
        enabledTitle: 'Show or hide the terrain analysis panel',
        icon: ICON_ANALYSE,
        classes: ['olv-tool-analyse'],
        disabled: true,
        toggle: true,
        blur: true,
        onClick: callbacks.onAnalyseToggle,
      },
      // "Copy view link" copies only the camera angle and viewport settings.
      // The recipient still has to open the *same scan file* on their own
      // device before the link does anything visible. This is a deliberate
      // consequence of the local-first architecture: scan data never leaves
      // the user's machine. The label and tooltip are written to make that
      // contract obvious at first read — earlier wording ("Share") implied
      // collaborative behaviour the architecture cannot deliver. v0.3.10.
      // `olv-dock-gap` opens the meta-tools cluster; `olv-tool-share` is the
      // stable hook the phone stylesheet uses to file it under "More".
      {
        id: 'tool.share',
        label: COPY_VIEW_LINK_LABEL,
        title:
          'Copies the camera angle and view settings — not the scan itself. ' +
          'The recipient needs to open the same file first.',
        icon: ICON_LINK,
        classes: ['olv-tool-share', 'olv-dock-gap'],
        blur: true,
        onClick: () => {
          callbacks.onShare();
          this._flashShare();
        },
      },
      {
        id: 'tool.command',
        label: 'Commands',
        title: 'Open the command palette — search every action (also Cmd/Ctrl-K)',
        icon: ICON_COMMAND,
        classes: ['olv-tool-command'],
        blur: true,
        onClick: callbacks.onCommandPalette,
      },
      {
        id: 'tool.help',
        label: 'Help',
        title: 'Workflows, navigation and keyboard shortcuts — also the ? key',
        icon: ICON_HELP,
        classes: ['olv-tool-help'],
        blur: true,
        onClick: callbacks.onHelp,
      },
      // "More" disclosure for phones — hidden on desktop, shown on phones.
      // CSS hides Snapshot and Help by default on phones (low-value with no
      // keyboard). "More" toggles a `.olv-dock-more-open` class on the dock
      // that un-hides them. On desktop every button is visible and More never
      // appears. Built via `custom` because it is a bare `•••` glyph with no
      // icon+label structure and an aria-expanded disclosure state.
      {
        id: 'tool.more',
        label: '•••',
        title: 'More tools: Snapshot, Analyse, Copy view link, Help',
        custom: () => {
          const more = el('button', {
            className: 'olv-tool olv-tool-more',
            text: '•••',
            title: 'More tools: Snapshot, Analyse, Copy view link, Help',
            ariaLabel: 'Show more tools',
          });
          more.setAttribute('aria-expanded', 'false');
          more.addEventListener('click', () => {
            more.blur();
            const open = this.dock.classList.toggle('olv-dock-more-open');
            more.setAttribute('aria-expanded', open ? 'true' : 'false');
          });
          return more;
        },
      },
      // Close is its own destructive cluster at the far right (`olv-dock-gap`),
      // keeping its rose tint. It has an enabled state but NO active state.
      {
        id: 'tool.close',
        label: 'Close',
        title: 'Load a scan to enable',
        enabledTitle: 'Close the scan and return to the start',
        icon: ICON_CLOSE,
        classes: ['olv-tool-close', 'olv-dock-gap'],
        disabled: true,
        blur: true,
        onClick: callbacks.onClose,
      },
    ];

    // Gestalt proximity: three explicit clusters in one rail — work tools
    // (Frame…Analyse), meta tools (Copy view link, Commands, Help) and the
    // destructive Close group — separated by `olv-dock-gap` boundaries above.
    // (Slice/Section was previously a permanently disabled work tool; a
    // disabled tool in an active cluster reads as broken rather than as a
    // roadmap signal, so it was removed until the feature ships.)
    const buttons = specs.map((spec) => this._build(spec));
    this._share = this._buttons.get('tool.share')!;

    this.dock = el('div', { className: 'olv-dock' }, buttons);

    this._backendText = el('span', { className: 'olv-backend-text', text: 'initialising…' });
    this.backend = el('div', { className: 'olv-backend' }, [
      el('span', { className: 'olv-backend-dot' }),
      this._backendText,
    ]);
  }

  /** Build one dock button from its spec and register it for id-driven patching. */
  private _build(spec: DockToolSpec): HTMLButtonElement {
    const button = spec.custom ? spec.custom() : this._tool(spec.label, spec.title, spec.disabled ?? false, spec.icon);
    for (const cls of spec.classes ?? []) button.classList.add(cls);
    // Toggle buttons must carry aria-pressed from creation — the attribute's
    // mere presence is what tells assistive tech "this is a toggle", so it
    // cannot wait for the first setActive() call.
    if (spec.toggle) {
      button.setAttribute('aria-pressed', 'false');
      this._toggles.add(spec.id);
    }
    if (spec.onClick) {
      const handler = spec.onClick;
      button.addEventListener('click', () => {
        if (spec.blur) button.blur();
        handler();
      });
    }
    if (spec.enabledTitle !== undefined) {
      this._titles.set(spec.id, { enabled: spec.enabledTitle, disabled: spec.title });
    }
    this._buttons.set(spec.id, button);
    return button;
  }

  /**
   * Enable or disable a tool by id — enabled once a scan is loaded. Swaps in
   * the tool's enabled/disabled tooltip and, for a disabled toggle, forces its
   * active state off (disable clears active).
   */
  setEnabled(id: string, enabled: boolean): void {
    const button = this._buttons.get(id);
    if (!button) return;
    button.disabled = !enabled;
    const titles = this._titles.get(id);
    if (titles) button.title = enabled ? titles.enabled : titles.disabled;
    if (!enabled) this.setActive(id, false);
  }

  /**
   * Reflect whether a toggle tool is currently active. aria-pressed is the
   * canonical toggle-state signal for screen readers; the class only restyles.
   * The label stays fixed in both states — swapping it shifted the dock layout
   * on every toggle. No-op for a tool with no active variant (e.g. Close).
   */
  setActive(id: string, active: boolean): void {
    const button = this._buttons.get(id);
    if (!button || !this._toggles.has(id)) return;
    button.classList.toggle('olv-tool-active', active);
    button.setAttribute('aria-pressed', String(active));
  }

  /** Report which GPU backend the renderer initialised. */
  setBackend(backend: 'webgpu' | 'webgl2'): void {
    this._backendText.textContent = backendLabel(backend);
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

  // Thin, name-stable shims over the id-keyed API. They keep the ~11 call
  // sites in main.ts / openScan.ts unchanged; each delegates to setEnabled /
  // setActive on the matching manifest id.
  /** Enable or disable the Measure tool — enabled once a scan is loaded. */
  setMeasureEnabled(enabled: boolean): void {
    this.setEnabled('tool.measure', enabled);
  }

  /** Reflect whether measurement mode is currently active. */
  setMeasureActive(active: boolean): void {
    this.setActive('tool.measure', active);
  }

  /** Enable or disable the Inspect tool — enabled once a scan is loaded. */
  setInspectEnabled(enabled: boolean): void {
    this.setEnabled('tool.inspect', enabled);
  }

  /** Reflect whether point-inspection mode is currently active. */
  setInspectActive(active: boolean): void {
    this.setActive('tool.inspect', active);
  }

  /** Enable or disable the live Probe — enabled once a scan is loaded. */
  setProbeEnabled(enabled: boolean): void {
    this.setEnabled('tool.probe', enabled);
  }

  /** Reflect whether live-probe mode is currently active. */
  setProbeActive(active: boolean): void {
    this.setActive('tool.probe', active);
  }

  /** Enable or disable the Annotate tool — enabled once a scan is loaded. */
  setAnnotateEnabled(enabled: boolean): void {
    this.setEnabled('tool.annotate', enabled);
  }

  /** Reflect whether annotation mode is currently active. */
  setAnnotateActive(active: boolean): void {
    this.setActive('tool.annotate', active);
  }

  /** Enable or disable the Analyse tool — enabled once a scan is loaded. */
  setAnalyseEnabled(enabled: boolean): void {
    this.setEnabled('tool.analyse', enabled);
  }

  /** Reflect whether the terrain analysis panel is currently open. */
  setAnalyseActive(active: boolean): void {
    this.setActive('tool.analyse', active);
  }

  /** Enable or disable the Close action — enabled once a scan is loaded. */
  setCloseEnabled(enabled: boolean): void {
    this.setEnabled('tool.close', enabled);
  }

  /** Briefly confirm a share link was copied, then restore the label. */
  private _flashShare(): void {
    if (this._shareTimer !== undefined) window.clearTimeout(this._shareTimer);
    this._setToolLabel(this._share, 'Link copied');
    this._shareTimer = window.setTimeout(() => {
      this._setToolLabel(this._share, COPY_VIEW_LINK_LABEL);
      this._shareTimer = undefined;
    }, 2000);
  }

  /** Update a tool's text without disturbing its leading icon glyph. */
  private _setToolLabel(button: HTMLButtonElement, text: string): void {
    const span = button.querySelector('.olv-tool-label');
    if (span) span.textContent = text;
    else button.textContent = text;
    // Keep the accessible name with the visible one. The label span is
    // hidden in the icon-only landscape rail, so aria-label is what a screen
    // reader reads there.
    button.setAttribute('aria-label', text);
  }

  private _tool(
    label: string,
    title: string,
    disabled: boolean,
    icon?: string,
  ): HTMLButtonElement {
    // Icon + visible label (evidence: icon-only toolbars hurt first-time
    // users). The label is built via textContent (escaped) — only the trusted
    // static icon SVG goes through unsafeHtml — so a label can never inject
    // markup. The label rides in its own span so transient text swaps (e.g.
    // the share button's "Link copied") update the text without wiping the glyph.
    const button = el('button', { className: icon ? 'olv-tool olv-tool-ico' : 'olv-tool', title });
    if (icon) button.append(el('span', { className: 'olv-tool-ico-glyph', unsafeHtml: icon }));
    button.append(el('span', { className: 'olv-tool-label', text: label }));
    // The landscape-phone rail renders the dock icon-only (a vertical strip has
    // no room for captions and a squeezed caption is worse than none). The
    // accessible name would then come from an invisible span, so mirror the
    // label onto aria-label here. It wins over the hidden text in every
    // orientation and keeps the button announced identically on desktop.
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    return button;
  }
}
